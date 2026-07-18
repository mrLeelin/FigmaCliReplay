class PluginOperationScope {
  constructor(logger, name, context) {
    this.logger = logger;
    this.context = {
      operationId: context.operationId || logger.idFactory(),
      operationName: name,
      module: context.module || logger.module
    };
    this.startedAt = logger.clock();
    this.stepIndex = 0;
    this.terminal = false;
    logger.emit("info", "started", "operation.start", "插件操作开始", context.data || {}, this.context, 0);
  }

  step(step, message, data, level) {
    if (this.terminal) return;
    this.stepIndex += 1;
    this.logger.emit(level || "info", "progress", step, message || step, data || {}, this.context, this.stepIndex, null, this.logger.clock() - this.startedAt);
  }

  succeed(message, data) {
    this.finish("info", "succeeded", message || "插件操作成功", null, data || {});
  }

  fail(error, message, data) {
    this.finish("error", "failed", message || "插件操作失败", error, data || {});
  }

  cancel(reason, data) {
    this.finish("warn", "cancelled", reason || "插件操作已取消", null, data || {});
  }

  finish(level, status, message, error, data) {
    if (this.terminal) {
      this.stepIndex += 1;
      this.logger.emit("warn", "progress", "operation.terminal.ignored", "忽略重复插件终态", {}, this.context, this.stepIndex);
      return;
    }
    this.terminal = true;
    this.stepIndex += 1;
    this.logger.emit(level, status, "operation.complete", message, data, this.context, this.stepIndex, error, this.logger.clock() - this.startedAt);
  }
}

class PluginLogger {
  constructor(options) {
    options = options || {};
    this.module = options.module || "figma-plugin";
    this.clock = options.clock || Date.now;
    this.idFactory = options.idFactory || function () {
      return "plugin-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    };
    this.postEvent = options.postEvent || function () {};
  }

  startOperation(name, context) {
    return new PluginOperationScope(this, name, context || {});
  }

  trace(message, data, context) { this.log("trace", message, data, context); }
  debug(message, data, context) { this.log("debug", message, data, context); }
  info(message, data, context) { this.log("info", message, data, context); }
  warn(message, data, context) { this.log("warn", message, data, context); }
  error(message, error, data, context) {
    this.emit("error", "failed", "diagnostic", message, data || {}, context || {}, 0, error);
  }

  log(level, message, data, context) {
    this.emit(level, "progress", "diagnostic", message, data || {}, context || {}, 0);
  }

  emit(level, status, step, message, data, context, stepIndex, error, durationMs) {
    var event = {
      timestamp: new Date(this.clock()).toISOString(),
      level: level,
      source: "plugin",
      module: context.module || this.module,
      operationId: context.operationId || this.idFactory(),
      operationName: context.operationName || "diagnostic",
      step: step,
      stepIndex: stepIndex,
      status: status,
      message: String(message || ""),
      data: redactPluginLogData(data || {})
    };
    if (durationMs !== undefined) event.durationMs = durationMs;
    if (error) {
      event.error = {
        name: error && error.name ? String(error.name) : "Error",
        message: error && error.message ? String(error.message) : String(error),
        stack: error && error.stack ? String(error.stack).slice(0, 4096) : undefined
      };
    }
    try {
      this.postEvent(event);
    } catch (postError) {
      try { console.error("[PluginLogger emergency]", postError); } catch (_) {}
    }
  }
}

function redactPluginLogData(value) {
  var sensitive = /password|token|authorization|cookie|api.?key|secret/i;
  function visit(item, key, depth) {
    if (sensitive.test(key || "")) return "[REDACTED]";
    if (depth > 6) return "[Depth limited]";
    if (typeof item === "string") {
      if (item.length > 4096) return { kind: "large-payload", chars: item.length, truncated: true };
      return item;
    }
    if (!item || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.slice(0, 200).map(function (child) { return visit(child, key, depth + 1); });
    var result = {};
    Object.keys(item).slice(0, 200).forEach(function (childKey) {
      result[childKey] = visit(item[childKey], childKey, depth + 1);
    });
    return result;
  }
  return visit(value || {}, "", 0);
}

const pluginLogger = new PluginLogger({
  module: "figma-plugin",
  postEvent: function (event) {
    figma.ui.postMessage({ type: "LOG_EVENT", event: event });
  }
});
