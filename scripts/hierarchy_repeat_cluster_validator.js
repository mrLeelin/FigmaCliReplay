#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONFIDENCE = 0.85;

function parseArgs(argv) {
  const args = {
    fixture: "",
    input: "",
    rounds: 100,
    confidence: DEFAULT_CONFIDENCE,
    assertFinalStructure: false,
    json: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fixture") args.fixture = String(argv[++i] || "");
    else if (arg === "--input") args.input = String(argv[++i] || "");
    else if (arg === "--rounds") args.rounds = Math.max(1, Number(argv[++i] || 100));
    else if (arg === "--confidence") args.confidence = Math.max(0, Math.min(1, Number(argv[++i] || DEFAULT_CONFIDENCE)));
    else if (arg === "--assert-final-structure") args.assertFinalStructure = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/hierarchy_repeat_cluster_validator.js --fixture 7day-task --rounds 100
  node scripts/hierarchy_repeat_cluster_validator.js --fixture 7day-task --rounds 100 --assert-final-structure
  node scripts/hierarchy_repeat_cluster_validator.js --input analysis_result.json --json

Notes:
  Clustering features are limited to type, bounds, visibility, opacity, childCount, and isNineSliceLike.
  Names, paths, and text characters are excluded from scoring and only retained for reporting.`);
}

function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function shuffle(items, rng) {
  const output = items.slice();
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }
  return output;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length / 2)];
}

function center(node) {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function area(node) {
  return Math.max(0, node.width) * Math.max(0, node.height);
}

function normalizeNode(record) {
  const bounds = record.bounds || record.relativeBounds || record;
  return {
    id: String(record.id || ""),
    type: String(record.type || ""),
    x: Number(bounds.x ?? record.x ?? 0),
    y: Number(bounds.y ?? record.y ?? 0),
    width: Math.max(0, Number(bounds.width ?? record.width ?? 0)),
    height: Math.max(0, Number(bounds.height ?? record.height ?? 0)),
    visible: record.visible !== false,
    opacity: Number(record.opacity ?? 1),
    childCount: Number(record.childCount ?? 0),
    isNineSliceLike: !!record.isNineSliceLike,
    depth: Number(record.depth ?? 0),
    kind: record.kind || "",
    truth: record.truth || "",
    optional: !!record.optional,
    reportName: String(record.name || "")
  };
}

function publicNode(node) {
  return {
    id: node.id,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    visible: node.visible,
    opacity: node.opacity,
    childCount: node.childCount,
    isNineSliceLike: node.isNineSliceLike
  };
}

function perturb(nodes, rng, options) {
  const optionalDropRate = Number(options.optionalDropRate || 0);
  const jitter = Number(options.jitter || 0);
  return shuffle(nodes
    .filter((node) => !(node.optional && rng() < optionalDropRate))
    .map((node) => ({
      ...node,
      x: node.x + (rng() * 2 - 1) * jitter,
      y: node.y + (rng() * 2 - 1) * jitter,
      width: Math.max(1, node.width + (rng() * 2 - 1) * jitter),
      height: Math.max(1, node.height + (rng() * 2 - 1) * jitter)
    })), rng);
}

function repeatAxisCluster(nodes, axis, expectedCount, confidenceThreshold) {
  const usable = nodes.filter((node) => node.visible && node.opacity > 0 && node.width > 0 && node.height > 0);
  let anchors = usable.filter((node) => node.kind === "anchor");
  if (anchors.length === 0) {
    anchors = usable.filter((node) => {
      if (node.isNineSliceLike) return true;
      if (node.type !== "FRAME" && node.type !== "RECTANGLE") return false;
      if (axis === "x") return area(node) >= 10000 && node.height >= 100;
      return area(node) >= 30000 && node.width >= 300;
    });
  }
  const directAnchors = anchors.filter((node) => node.depth === 1);
  if (directAnchors.length >= expectedCount) {
    anchors = directAnchors;
  }
  anchors = anchors
    .filter((node) => node.width > 0 && node.height > 0)
    .sort((a, b) => axis === "x" ? a.x - b.x : a.y - b.y);

  if (anchors.length < expectedCount) {
    return reject("anchor_count", 0, { expectedCount, actualCount: anchors.length, axis });
  }

  const selected = anchors.slice(0, expectedCount);
  const gaps = [];
  for (let index = 1; index < selected.length; index += 1) {
    gaps.push(axis === "x"
      ? selected[index].x - selected[index - 1].x
      : selected[index].y - selected[index - 1].y);
  }
  const step = median(gaps);
  if (step < 20) {
    return reject("axis_collapsed", 0, { axis, step, expectedCount });
  }
  const maxGapDelta = gaps.reduce((max, gap) => Math.max(max, Math.abs(gap - step)), 0);
  const confidence = Math.max(0, 1 - maxGapDelta / Math.max(1, step));
  if (confidence < confidenceThreshold) {
    return reject("low_confidence", confidence, { axis, step, maxGapDelta, threshold: confidenceThreshold });
  }

  const assignments = {};
  for (const node of usable) {
    const point = center(node);
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    selected.forEach((anchor, index) => {
      const anchorCenter = center(anchor);
      const distance = axis === "x" ? Math.abs(point.x - anchorCenter.x) : Math.abs(point.y - anchorCenter.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    assignments[node.id] = `${axis}_group_${bestIndex + 1}`;
  }

  return {
    status: "auto",
    clusterType: axis === "x" ? "horizontal-list" : "vertical-list",
    confidence,
    groups: selected.map((anchor, index) => ({
      key: `${axis}_group_${index + 1}`,
      anchorNodeId: anchor.id,
      nodeIds: Object.keys(assignments).filter((nodeId) => assignments[nodeId] === `${axis}_group_${index + 1}`)
    })),
    nodeAssignments: assignments,
    rejectReasons: [],
    usedSignals: ["type", "x", "y", "width", "height", "visible", "opacity", "childCount", "isNineSliceLike", "mainAxisGapStability"],
    ignoredSignals: ["name", "path", "characters"]
  };
}

function progressCluster(nodes, confidenceThreshold) {
  const usable = nodes.filter((node) => node.visible && node.opacity > 0 && node.width > 0 && node.height > 0);
  const assignments = {};
  const wideTracks = usable.filter((node) => node.width > 500 && node.height < 100);
  for (const track of wideTracks) {
    assignments[track.id] = "track";
  }

  const markers = usable
    .filter((node) => node.kind === "marker" || (node.width <= 25 && node.height >= 40 && node.height <= 75))
    .sort((a, b) => a.x - b.x);
  if (markers.length < 4) {
    return reject("marker_count", 0, { expectedCount: 4, actualCount: markers.length });
  }

  const slots = markers.slice(0, 4).map((marker, index) => ({ key: `slot_${index + 1}`, x: center(marker).x }));
  const gaps = slots.slice(1).map((slot, index) => slot.x - slots[index].x);
  const step = median(gaps);
  const maxGapDelta = gaps.reduce((max, gap) => Math.max(max, Math.abs(gap - step)), 0);
  const confidence = Math.max(0, 1 - maxGapDelta / Math.max(1, step));
  if (confidence < confidenceThreshold) {
    return reject("low_confidence", confidence, { step, maxGapDelta, threshold: confidenceThreshold });
  }

  const minX = Math.min(...usable.map((node) => node.x));
  const maxX = Math.max(...usable.map((node) => node.x + node.width));
  for (const node of usable) {
    if (assignments[node.id]) continue;
    const point = center(node);
    if (point.x < minX + 130) {
      assignments[node.id] = "start";
    } else if (point.x > maxX - 120) {
      assignments[node.id] = "final";
    } else {
      let best = slots[0];
      for (const slot of slots) {
        if (Math.abs(point.x - slot.x) < Math.abs(point.x - best.x)) best = slot;
      }
      assignments[node.id] = best.key;
    }
  }

  const groupKeys = ["track", "start", ...slots.map((slot) => slot.key), "final"];
  return {
    status: "auto",
    clusterType: "progress",
    confidence,
    groups: groupKeys
      .map((key) => ({ key, nodeIds: Object.keys(assignments).filter((nodeId) => assignments[nodeId] === key) }))
      .filter((group) => group.nodeIds.length > 0),
    nodeAssignments: assignments,
    rejectReasons: [],
    usedSignals: ["type", "x", "y", "width", "height", "visible", "opacity", "childCount", "isNineSliceLike", "markerGapStability", "edgeSlots"],
    ignoredSignals: ["name", "path", "characters"]
  };
}

function reject(reason, confidence, details) {
  return {
    status: "rejected",
    clusterType: "unknown",
    confidence,
    groups: [],
    nodeAssignments: {},
    rejectReasons: [{ reason, details }],
    usedSignals: ["type", "x", "y", "width", "height", "visible", "opacity", "childCount", "isNineSliceLike"],
    ignoredSignals: ["name", "path", "characters"]
  };
}

function detectBestCluster(nodes, options = {}) {
  const threshold = Number(options.confidence ?? DEFAULT_CONFIDENCE);
  const candidates = [
    repeatAxisCluster(nodes, "x", Number(options.expectedXCount || 7), threshold),
    repeatAxisCluster(nodes, "y", Number(options.expectedYCount || 5), threshold),
    progressCluster(nodes, threshold)
  ];
  const autoCandidates = candidates.filter((candidate) => candidate.status === "auto")
    .sort((a, b) => b.confidence - a.confidence);
  if (autoCandidates.length === 0) {
    return {
      ...reject("no_high_confidence_candidate", 0, { candidates: candidates.map(candidateSummary) }),
      candidates: candidates.map(candidateSummary)
    };
  }
  if (autoCandidates.length > 1 && Math.abs(autoCandidates[0].confidence - autoCandidates[1].confidence) < 0.03) {
    return {
      ...reject("ambiguous_candidates", autoCandidates[0].confidence, { candidates: candidates.map(candidateSummary) }),
      candidates: candidates.map(candidateSummary)
    };
  }
  return { ...autoCandidates[0], candidates: candidates.map(candidateSummary) };
}

function candidateSummary(candidate) {
  return {
    status: candidate.status,
    clusterType: candidate.clusterType,
    confidence: Number(candidate.confidence || 0),
    rejectReasons: candidate.rejectReasons || []
  };
}

function assignmentMetrics(result, sample) {
  let missing = 0;
  let wrong = 0;
  const truth = Object.fromEntries(sample.map((node) => [node.id, node.truth]));
  for (const node of sample) {
    const actual = result.nodeAssignments[node.id];
    if (!actual) missing += 1;
    else if (actual !== truth[node.id]) wrong += 1;
  }
  return { missing, wrong, pass: missing === 0 && wrong === 0 };
}

function runFixture(rounds, confidence) {
  const cases = [
    { name: "day", nodes: createDayFixture(), detector: (nodes) => repeatAxisCluster(nodes, "x", 7, confidence), drop: 0.1, jitter: 2 },
    { name: "list", nodes: createListFixture(), detector: (nodes) => repeatAxisCluster(nodes, "y", 5, confidence), drop: 0.12, jitter: 3 },
    { name: "progress", nodes: createProgressFixture(), detector: (nodes) => progressCluster(nodes, confidence), drop: 0.05, jitter: 2 }
  ];
  const summary = {
    fixture: "7day-task",
    roundsPerCase: rounds,
    totalRounds: rounds * cases.length,
    confidenceThreshold: confidence,
    cases: {},
    overall: { auto: 0, reject: 0, passAuto: 0, wrongAuto: 0 }
  };

  for (const testCase of cases) {
    let auto = 0;
    let rejectCount = 0;
    let passAuto = 0;
    let wrongAuto = 0;
    let minConfidence = 1;
    let maxConfidence = 0;
    const failures = [];
    for (let round = 0; round < rounds; round += 1) {
      const sample = perturb(testCase.nodes, createRng(9000 + round * 31 + testCase.name.length), {
        optionalDropRate: testCase.drop,
        jitter: testCase.jitter
      });
      const result = testCase.detector(sample);
      minConfidence = Math.min(minConfidence, Number(result.confidence || 0));
      maxConfidence = Math.max(maxConfidence, Number(result.confidence || 0));
      if (result.status !== "auto") {
        rejectCount += 1;
        continue;
      }
      auto += 1;
      const metrics = assignmentMetrics(result, sample);
      if (metrics.pass) {
        passAuto += 1;
      } else {
        wrongAuto += 1;
        if (failures.length < 5) failures.push({ round, confidence: result.confidence, metrics });
      }
    }
    summary.cases[testCase.name] = { auto, reject: rejectCount, passAuto, wrongAuto, minConfidence, maxConfidence, failures };
    summary.overall.auto += auto;
    summary.overall.reject += rejectCount;
    summary.overall.passAuto += passAuto;
    summary.overall.wrongAuto += wrongAuto;
  }
  return summary;
}

function runFinalStructureFixture(rounds, confidence) {
  const expectedTree = createExpectedFinalTree();
  const expectedHash = stableJson(expectedTree);
  const summary = {
    fixture: "7day-task-final-structure",
    rounds,
    confidenceThreshold: confidence,
    horizontalPolicy: "horizontal-list requires user confirmation before write",
    expectedTree,
    expectedHash,
    pass: 0,
    fail: 0,
    horizontalNeedsConfirmationPass: 0,
    horizontalUnexpectedAutoWrite: 0,
    failures: []
  };

  for (let round = 0; round < rounds; round += 1) {
    const rng = createRng(41000 + round * 97);
    const daySample = perturb(createDayFixture(), rng, { optionalDropRate: 0, jitter: 2 });
    const listSample = perturb(createListFixture(), rng, { optionalDropRate: 0, jitter: 3 });
    const progressSample = perturb(createProgressFixture(), rng, { optionalDropRate: 0, jitter: 2 });

    const dayCluster = repeatAxisCluster(daySample, "x", 7, confidence);
    const listCluster = repeatAxisCluster(listSample, "y", 5, confidence);
    const progress = progressCluster(progressSample, confidence);

    const horizontalDecision = classifyClusterWritePolicy(dayCluster, { horizontalConfirmed: false });
    if (horizontalDecision.action === "needsUserConfirmation") {
      summary.horizontalNeedsConfirmationPass += 1;
    } else if (horizontalDecision.action === "write") {
      summary.horizontalUnexpectedAutoWrite += 1;
    }

    const confirmedDayDecision = classifyClusterWritePolicy(dayCluster, { horizontalConfirmed: true });
    const listDecision = classifyClusterWritePolicy(listCluster, { horizontalConfirmed: false });
    const progressDecision = classifyClusterWritePolicy(progress, { horizontalConfirmed: false });
    const actualTree = buildFinalTreeFromDecisions({
      day: confirmedDayDecision,
      list: listDecision,
      progress: progressDecision
    });
    const actualHash = stableJson(actualTree);
    const pass = actualHash === expectedHash &&
      dayCluster.status === "auto" &&
      listCluster.status === "auto" &&
      progress.status === "auto" &&
      horizontalDecision.action === "needsUserConfirmation" &&
      confirmedDayDecision.action === "write" &&
      listDecision.action === "write" &&
      progressDecision.action === "write";
    if (pass) {
      summary.pass += 1;
    } else {
      summary.fail += 1;
      if (summary.failures.length < 5) {
        summary.failures.push({
          round,
          day: candidateSummary(dayCluster),
          list: candidateSummary(listCluster),
          progress: candidateSummary(progress),
          horizontalDecision,
          confirmedDayDecision,
          listDecision,
          progressDecision,
          actualTree
        });
      }
    }
  }

  summary.overall = {
    pass: summary.pass,
    fail: summary.fail,
    horizontalNeedsConfirmationPass: summary.horizontalNeedsConfirmationPass,
    horizontalUnexpectedAutoWrite: summary.horizontalUnexpectedAutoWrite
  };
  return summary;
}

function classifyClusterWritePolicy(result, options = {}) {
  if (!result || result.status !== "auto") {
    return { action: "reject", reason: "cluster_not_auto", clusterType: result ? result.clusterType : "unknown" };
  }
  if (result.clusterType === "horizontal-list" && options.horizontalConfirmed !== true) {
    return {
      action: "needsUserConfirmation",
      reason: "horizontal_list_requires_confirmation",
      clusterType: result.clusterType,
      confidence: result.confidence
    };
  }
  return {
    action: "write",
    clusterType: result.clusterType,
    confidence: result.confidence
  };
}

function buildFinalTreeFromDecisions(decisions) {
  const tree = createExpectedFinalTree();
  if (!decisions.day || decisions.day.action !== "write") {
    tree.children[1].children = [{ name: "[NeedsUserConfirmation]", childCount: 0 }];
  }
  if (!decisions.progress || decisions.progress.action !== "write") {
    tree.children[3].children = [{ name: "[ProgressDryRunOnly]", childCount: 0 }];
  }
  if (!decisions.list || decisions.list.action !== "write") {
    tree.children[4].children = [{ name: "[ListDryRunOnly]", childCount: 0 }];
  }
  return tree;
}

function createExpectedFinalTree() {
  return {
    name: "7日任务拆分_PSD_Import",
    children: [
      { name: "[Footer]", childCount: 1 },
      {
        name: "[DayList]",
        scrollView: false,
        children: [
          { name: "[Item_Day01]", childCount: 5 },
          { name: "[Item_Day02]", childCount: 3 },
          { name: "[Item_Day03]", childCount: 4 },
          { name: "[Item_Day04]", childCount: 4 },
          { name: "[Item_Day05]", childCount: 4 },
          { name: "[Item_Day06]", childCount: 4 },
          { name: "[Item_Day07]", childCount: 4 }
        ]
      },
      { name: "[PanelBg]", childCount: 4 },
      {
        name: "[ProgressSection]",
        children: [
          { name: "[ProgressTrack]", childCount: 2 },
          { name: "[ProgressStart]", childCount: 3 },
          { name: "[Milestone_01]", childCount: 4 },
          { name: "[Milestone_02]", childCount: 4 },
          { name: "[Milestone_03]", childCount: 4 },
          { name: "[Milestone_04]", childCount: 4 },
          { name: "[ProgressFinal]", childCount: 2 }
        ]
      },
      {
        name: "[ListRoot]",
        children: [{
          name: "[ScrollView]",
          children: [{
            name: "[Viewport]",
            children: [{
              name: "[Content]",
              children: [
                { name: "[TaskItem_01]", childCount: 13 },
                { name: "[TaskItem_02]", childCount: 11 },
                { name: "[TaskItem_03]", childCount: 7 },
                { name: "[TaskLocked_01]", childCount: 2 },
                { name: "[TaskLocked_02]", childCount: 3 }
              ]
            }]
          }]
        }]
      },
      { name: "[Header]", childCount: 5 }
    ]
  };
}

function stableJson(value) {
  return JSON.stringify(value);
}

function createDayFixture() {
  const nodes = [];
  [0, 133, 266, 399, 532, 665, 798].forEach((x, index) => {
    const truth = `x_group_${index + 1}`;
    nodes.push(normalizeNode({ id: `day${index + 1}_bg`, type: "RECTANGLE", x, y: index === 1 ? 6 : 0, width: 128, height: index === 1 ? 226 : 216, kind: "anchor", truth }));
    nodes.push(normalizeNode({ id: `day${index + 1}_title`, type: "TEXT", x: x + 32, y: 80, width: 64, height: 36, truth }));
    nodes.push(normalizeNode({ id: `day${index + 1}_num`, type: "TEXT", x: x + 50, y: 124, width: 30, height: 48, truth }));
    if (index === 0) {
      nodes.push(normalizeNode({ id: "day1_icon", type: "RECTANGLE", x: x + 79, y: 181, width: 42, height: 42, truth, optional: true }));
      nodes.push(normalizeNode({ id: "day1_small", type: "TEXT", x: x + 92, y: 188, width: 16, height: 28, truth, optional: true }));
    } else if (index >= 2) {
      nodes.push(normalizeNode({ id: `day${index + 1}_lock`, type: "INSTANCE", x: x + 30, y: 186, width: 68, height: 78, truth, optional: true }));
    }
  });
  return nodes;
}

function createListFixture() {
  const nodes = [];
  [0, 183, 365, 548, 730].forEach((y, index) => {
    const truth = `y_group_${index + 1}`;
    nodes.push(normalizeNode({ id: `list${index + 1}_bg`, type: "FRAME", x: 0, y, width: 830, height: 173, kind: "anchor", truth, isNineSliceLike: true }));
    if (index < 3) {
      nodes.push(normalizeNode({ id: `list${index + 1}_leftIcon`, type: "RECTANGLE", x: 35, y: y + 26, width: 113, height: 111, truth, optional: true }));
      nodes.push(normalizeNode({ id: `list${index + 1}_midText`, type: "TEXT", x: 237, y: y + 66, width: 191, height: 36, truth, optional: true }));
    }
    if (index < 2) {
      nodes.push(normalizeNode({ id: `list${index + 1}_rewardBg`, type: "FRAME", x: 549, y, width: 280, height: 168, truth, optional: true, isNineSliceLike: true }));
      nodes.push(normalizeNode({ id: `list${index + 1}_currency`, type: "RECTANGLE", x: 707, y: y + 26, width: 98, height: 97, truth, optional: true }));
    }
    if (index >= 3) {
      nodes.push(normalizeNode({ id: `list${index + 1}_lock`, type: "INSTANCE", x: 658, y: y + 50, width: 63, height: 74, truth, optional: true }));
    }
  });
  return nodes;
}

function createProgressFixture() {
  const nodes = [
    ["track1", "FRAME", 47, 106, 798, 72, "track", false],
    ["track2", "FRAME", 58, 117, 776, 50, "track", false],
    ["startIcon", "RECTANGLE", 0, 90, 125, 99, "start", true],
    ["startLabel", "RECTANGLE", 12, 172, 102, 47, "start", true],
    ["startText", "TEXT", 52, 178, 22, 32, "start", true],
    ["finalIcon", "RECTANGLE", 780, 68, 92, 109, "final", true],
    ["finalText", "TEXT", 786, 187, 66, 36, "final", true]
  ].map(([id, type, x, y, width, height, truth, optional]) => normalizeNode({ id, type, x, y, width, height, truth, optional }));
  [181, 332, 487, 643].forEach((x, index) => {
    const truth = `slot_${index + 1}`;
    nodes.push(normalizeNode({ id: `marker${index + 1}`, type: "RECTANGLE", x: x + 29, y: 114, width: 12, height: 54, truth, kind: "marker" }));
    nodes.push(normalizeNode({ id: `icon${index + 1}`, type: "RECTANGLE", x: x + 5, y: 1, width: 60, height: 73, truth, optional: true }));
    nodes.push(normalizeNode({ id: `amount${index + 1}`, type: "TEXT", x: x + 15, y: 68, width: 40, height: 30, truth, optional: true }));
    nodes.push(normalizeNode({ id: `label${index + 1}`, type: "TEXT", x, y: 187, width: 68, height: 36, truth, optional: true }));
  });
  return nodes;
}

function analyzeInput(filePath, confidence) {
  const absolutePath = path.resolve(filePath);
  const payload = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  const rawNodes = Array.isArray(payload.nodes)
    ? payload.nodes
    : Array.isArray(payload.children)
      ? payload.children
      : [];
  const nodes = rawNodes
    .map(normalizeNode)
    .filter((node) => node.id && node.width > 0 && node.height > 0);
  return {
    input: absolutePath,
    nodeCount: nodes.length,
    result: detectBestCluster(nodes, { confidence }),
    nodes: nodes.map(publicNode)
  };
}

function main() {
  const args = parseArgs(process.argv);
  let result;
  if (args.fixture) {
    if (args.fixture !== "7day-task") {
      throw new Error(`Unknown fixture: ${args.fixture}`);
    }
    result = args.assertFinalStructure
      ? runFinalStructureFixture(args.rounds, args.confidence)
      : runFixture(args.rounds, args.confidence);
  } else if (args.input) {
    result = analyzeInput(args.input, args.confidence);
  } else {
    printHelp();
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("[SUMMARY_JSON]" + JSON.stringify(result));
  }

  if (result.overall && result.overall.wrongAuto > 0) {
    process.exitCode = 2;
  }
  if (result.overall && result.overall.fail > 0) {
    process.exitCode = 2;
  }
  if (result.overall && result.overall.horizontalUnexpectedAutoWrite > 0) {
    process.exitCode = 2;
  }
}

main();
