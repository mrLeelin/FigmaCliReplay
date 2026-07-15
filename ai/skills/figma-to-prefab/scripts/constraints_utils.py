"""Shared Figma Constraints to Unity RectTransform conversion helpers."""

VALID_FIGMA_CONSTRAINTS = {"MIN", "CENTER", "MAX", "STRETCH"}


def normalize_figma_constraint(value, fallback="CENTER"):
    """Normalize a Figma constraint token for deterministic Unity anchor conversion."""

    normalized = str(value or fallback or "CENTER").upper()
    return normalized if normalized in VALID_FIGMA_CONSTRAINTS else fallback


def figma_constraint_axis_to_unity_anchor(value, axis):
    """Convert one Figma constraint axis to Unity anchorMin/anchorMax values."""

    constraint = normalize_figma_constraint(value)
    if constraint == "STRETCH":
        return 0.0, 1.0
    if axis == "x":
        if constraint == "MIN":
            return 0.0, 0.0
        if constraint == "MAX":
            return 1.0, 1.0
    else:
        if constraint == "MIN":
            return 1.0, 1.0
        if constraint == "MAX":
            return 0.0, 0.0
    return 0.5, 0.5


def figma_constraints_to_rect_transform_spec(constraints):
    """Build Unity RectTransform anchor metadata from Figma Constraints."""

    constraints = constraints or {}
    horizontal = normalize_figma_constraint(constraints.get("horizontal"), "CENTER")
    vertical = normalize_figma_constraint(constraints.get("vertical"), "CENTER")
    anchor_min_x, anchor_max_x = figma_constraint_axis_to_unity_anchor(horizontal, "x")
    anchor_min_y, anchor_max_y = figma_constraint_axis_to_unity_anchor(vertical, "y")
    return {
        "anchorMin": {"x": anchor_min_x, "y": anchor_min_y},
        "anchorMax": {"x": anchor_max_x, "y": anchor_max_y},
        "pivot": {"x": 0.5, "y": 0.5},
        "constraints": {
            "horizontal": horizontal,
            "vertical": vertical,
        },
    }


def convert_figma_bounds_to_unity_rect(child_bounds, parent_bounds, rect_transform=None):
    """Convert Figma local bounds into Unity anchoredPosition and sizeDelta."""

    width = child_bounds["width"]
    height = child_bounds["height"]
    parent_width = parent_bounds["width"]
    parent_height = parent_bounds["height"]
    anchor_min = (rect_transform or {}).get("anchorMin") or {"x": 0.5, "y": 0.5}
    anchor_max = (rect_transform or {}).get("anchorMax") or anchor_min
    pivot = (rect_transform or {}).get("pivot") or {"x": 0.5, "y": 0.5}
    local_x = child_bounds["x"] - parent_bounds["x"]
    local_y = child_bounds["y"] - parent_bounds["y"]
    span_width = (anchor_max["x"] - anchor_min["x"]) * parent_width
    span_height = (anchor_max["y"] - anchor_min["y"]) * parent_height
    size_delta_x = width - span_width
    size_delta_y = height - span_height
    pivot_x = local_x + width * pivot["x"]
    pivot_y_unity = parent_height - local_y - height * (1 - pivot["y"])
    anchored_x = pivot_x - anchor_min["x"] * parent_width - span_width * pivot["x"]
    anchored_y = pivot_y_unity - anchor_min["y"] * parent_height - span_height * pivot["y"]
    return {
        "x": round(anchored_x, 1),
        "y": round(anchored_y, 1),
        "w": round(size_delta_x, 1),
        "h": round(size_delta_y, 1),
    }
