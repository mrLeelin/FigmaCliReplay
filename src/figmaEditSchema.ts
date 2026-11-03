import { z } from "zod";

/** 通用设计编辑 job：只读 inspect 与白名单批量写入。Relay 在派发前严格校验，插件只执行通过校验的操作。 */
export const FIGMA_INSPECT_NODES = "FIGMA_INSPECT_NODES";
export const FIGMA_APPLY_EDITS = "FIGMA_APPLY_EDITS";

export const MAX_INSPECT_NODE_IDS = 50;
export const MAX_EDITS_PER_BATCH = 100;

const figmaNodeId = z.string().regex(/^I?-?\d+:\d+(;-?\d+:\d+)*$/, "invalid Figma node id");
const tempId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "invalid tempId");
/** 写入目标：真实节点 ID，或同批 create 操作产生的 temp:<tempId>。 */
const nodeRef = z.union([figmaNodeId, z.string().regex(/^temp:[A-Za-z0-9_-]{1,64}$/, "invalid temp reference")]);
const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "color must be #RRGGBB");
const unit = z.number().finite().min(0).max(1);
const size = z.number().finite().min(0.01).max(100000);
const coordinate = z.number().finite().min(-1000000).max(1000000);
const spacing = z.number().finite().min(0).max(10000);
const fontStyleFields = {
  fontFamily: z.string().trim().min(1).max(200).optional(),
  fontStyle: z.string().trim().min(1).max(100).optional(),
};

const padding = z.union([
  spacing,
  z.object({ top: spacing.optional(), right: spacing.optional(), bottom: spacing.optional(), left: spacing.optional() }).strict(),
]);

/** bindVariable 允许绑定的字段：仅限数值/颜色类布局与外观属性。 */
export const BINDABLE_FIELDS = [
  "fills", "strokes", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "cornerRadius", "opacity", "width", "height", "strokeWeight",
] as const;

const editOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("setFill"), nodeId: nodeRef, color: hexColor, opacity: unit.optional() }).strict(),
  z.object({ op: z.literal("setStroke"), nodeId: nodeRef, color: hexColor, weight: z.number().finite().min(0).max(100).optional() }).strict(),
  z.object({ op: z.literal("setCornerRadius"), nodeId: nodeRef, radius: z.number().finite().min(0).max(10000) }).strict(),
  z.object({ op: z.literal("setOpacity"), nodeId: nodeRef, opacity: unit }).strict(),
  z.object({ op: z.literal("setVisible"), nodeId: nodeRef, visible: z.boolean() }).strict(),
  z.object({ op: z.literal("rename"), nodeId: nodeRef, name: z.string().trim().min(1).max(200) }).strict(),
  z.object({ op: z.literal("setText"), nodeId: nodeRef, characters: z.string().max(5000) }).strict(),
  z.object({
    op: z.literal("setTextStyle"), nodeId: nodeRef,
    fontSize: z.number().finite().min(1).max(1000).optional(),
    ...fontStyleFields,
    align: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
  }).strict(),
  z.object({
    op: z.literal("setAutoLayout"), nodeId: nodeRef,
    mode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]),
    itemSpacing: spacing.optional(),
    padding: padding.optional(),
    primaryAlign: z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]).optional(),
    counterAlign: z.enum(["MIN", "CENTER", "MAX", "BASELINE"]).optional(),
    sizing: z.object({ primary: z.enum(["FIXED", "AUTO"]).optional(), counter: z.enum(["FIXED", "AUTO"]).optional() }).strict().optional(),
  }).strict(),
  z.object({
    op: z.literal("setLayoutSizing"), nodeId: nodeRef,
    horizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
    vertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
  }).strict(),
  z.object({
    op: z.literal("createFrame"), parentId: nodeRef, tempId,
    name: z.string().trim().min(1).max(200), width: size, height: size,
    x: coordinate.optional(), y: coordinate.optional(), index: z.number().int().min(0).max(100000).optional(),
  }).strict(),
  z.object({
    op: z.literal("createText"), parentId: nodeRef, tempId,
    characters: z.string().max(5000), fontSize: z.number().finite().min(1).max(1000).optional(), ...fontStyleFields,
    x: coordinate.optional(), y: coordinate.optional(), index: z.number().int().min(0).max(100000).optional(),
  }).strict(),
  z.object({
    op: z.literal("createInstance"), parentId: nodeRef, tempId, componentId: figmaNodeId,
    x: coordinate.optional(), y: coordinate.optional(), index: z.number().int().min(0).max(100000).optional(),
  }).strict(),
  z.object({
    op: z.literal("setInstanceProperties"), nodeId: nodeRef,
    properties: z.record(z.string().min(1).max(200), z.union([z.string().max(5000), z.boolean()])).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 50, "properties must have 1-50 entries"),
  }).strict(),
  z.object({
    op: z.literal("bindVariable"), nodeId: nodeRef, field: z.enum(BINDABLE_FIELDS),
    variableId: z.string().regex(/^VariableID:[A-Za-z0-9:/_-]{1,200}$/, "invalid variableId"),
  }).strict(),
]);

export type FigmaEditOp = z.infer<typeof editOp>;

/** 每种 op 实际写入的属性键，用于拒绝同批内对同一节点同一属性的重复修改。 */
function touchedKeys(edit: FigmaEditOp): string[] {
  switch (edit.op) {
    case "setFill": return ["fills"];
    case "setStroke": return ["strokes", ...(edit.weight === undefined ? [] : ["strokeWeight"])];
    case "setCornerRadius": return ["cornerRadius"];
    case "setOpacity": return ["opacity"];
    case "setVisible": return ["visible"];
    case "rename": return ["name"];
    case "setText": return ["characters"];
    case "setTextStyle": return [
      ...(edit.fontSize === undefined ? [] : ["fontSize"]),
      ...(edit.fontFamily || edit.fontStyle ? ["fontName"] : []),
      ...(edit.align ? ["textAlignHorizontal"] : []),
    ];
    case "setAutoLayout": return ["layoutMode"];
    case "setLayoutSizing": return [...(edit.horizontal ? ["layoutSizingHorizontal"] : []), ...(edit.vertical ? ["layoutSizingVertical"] : [])];
    case "setInstanceProperties": return Object.keys(edit.properties).map((key) => "componentProperty:" + key);
    case "bindVariable": return ["boundVariable:" + edit.field];
    default: return [];
  }
}

export const figmaApplyEditsJobSchema = z.object({
  type: z.literal(FIGMA_APPLY_EDITS),
  dryRun: z.boolean().default(false),
  edits: z.array(editOp).min(1).max(MAX_EDITS_PER_BATCH),
}).strict().superRefine((job, context) => {
  const created = new Set<string>();
  const touched = new Map<string, number>();
  job.edits.forEach((edit, index) => {
    const references = "nodeId" in edit ? [edit.nodeId] : [edit.parentId];
    for (const reference of references) {
      if (reference.startsWith("temp:") && !created.has(reference.slice(5))) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["edits", index], message: `references ${reference} before it is created in this batch` });
      }
    }
    if ("tempId" in edit) {
      if (created.has(edit.tempId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["edits", index, "tempId"], message: `duplicate tempId ${edit.tempId}` });
      created.add(edit.tempId);
    }
    if (edit.op === "setTextStyle" && edit.fontSize === undefined && !edit.fontFamily && !edit.fontStyle && !edit.align) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["edits", index], message: "setTextStyle requires at least one field" });
    }
    if (edit.op === "setLayoutSizing" && !edit.horizontal && !edit.vertical) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["edits", index], message: "setLayoutSizing requires horizontal or vertical" });
    }
    if ("nodeId" in edit) {
      for (const key of touchedKeys(edit)) {
        const slot = edit.nodeId + "|" + key;
        const first = touched.get(slot);
        if (first !== undefined) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ["edits", index], message: `${key} of ${edit.nodeId} is already changed by edit ${first}` });
        } else {
          touched.set(slot, index);
        }
      }
    }
  });
});

export const figmaInspectNodesJobSchema = z.object({
  type: z.literal(FIGMA_INSPECT_NODES),
  nodeIds: z.array(figmaNodeId).min(1).max(MAX_INSPECT_NODE_IDS),
  depth: z.number().int().min(0).max(3).default(1),
  includeText: z.boolean().default(true),
}).strict();

/** 校验结果：只对两个设计编辑 job 生效，其余 jobType 返回 undefined 表示不处理。 */
export type FigmaEditJobValidation =
  | { ok: true; job: Record<string, unknown>; editCount: number; opCounts: Record<string, number> }
  | { ok: false; message: string; issueCount: number };

const MAX_ISSUES_IN_MESSAGE = 5;

export function validateFigmaEditJob(jobType: string, job: Record<string, unknown>): FigmaEditJobValidation | undefined {
  const schema = jobType === FIGMA_APPLY_EDITS ? figmaApplyEditsJobSchema
    : jobType === FIGMA_INSPECT_NODES ? figmaInspectNodesJobSchema : undefined;
  if (!schema) return undefined;
  const parsed = schema.safeParse({ ...job, type: jobType });
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const message = issues.slice(0, MAX_ISSUES_IN_MESSAGE)
      .map((issue) => (issue.path.length ? issue.path.join(".") + ": " : "") + issue.message)
      .join("; ");
    return { ok: false, message: `${jobType} rejected: ${message}${issues.length > MAX_ISSUES_IN_MESSAGE ? ` (+${issues.length - MAX_ISSUES_IN_MESSAGE} more)` : ""}`, issueCount: issues.length };
  }
  const data = parsed.data as Record<string, unknown>;
  const edits = Array.isArray(data.edits) ? data.edits as FigmaEditOp[] : [];
  const opCounts: Record<string, number> = {};
  for (const edit of edits) opCounts[edit.op] = (opCounts[edit.op] || 0) + 1;
  return { ok: true, job: data, editCount: edits.length, opCounts };
}
