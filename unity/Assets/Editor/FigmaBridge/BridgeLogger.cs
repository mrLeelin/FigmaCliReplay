using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace MagicWarrior.Editor.FigmaBridge
{
    /// <summary>
    /// Unity Bridge 唯一的日志输出入口。负责结构化事件、脱敏、JSONL 持久化和窗口通知。
    /// </summary>
    internal static class BridgeLogger
    {
        private const int MaxMemoryEvents = 1000;
        private const int MaxDisplayEvents = 200;
        private const int RetentionDays = 14;
        private const long MaxLogBytes = 200L * 1024L * 1024L;
        private const string UnitySourceJson = "\"source\":\"unity\"";
        private static readonly object Sync = new object();
        private static readonly List<BridgeLogEvent> Events = new List<BridgeLogEvent>();
        private static readonly List<string> RecentDisplayLogs = new List<string>();

        internal static event Action OnChanged;
        internal static IReadOnlyList<string> DisplayLogs => RecentDisplayLogs;

        static BridgeLogger()
        {
            CleanupOldFiles();
        }

        internal static BridgeOperationScope StartOperation(string operationName, string operationId = null)
        {
            return new BridgeOperationScope(operationName, operationId);
        }

        internal static void Trace(string message, string operationId = null, string operationName = "unity.diagnostic")
        {
            Emit("trace", "progress", "diagnostic", message, operationId, operationName, 0, 0, null);
        }

        internal static void Debug(string message, string operationId = null, string operationName = "unity.diagnostic")
        {
            Emit("debug", "progress", "diagnostic", message, operationId, operationName, 0, 0, null);
        }

        internal static void Info(string message, string operationId = null, string operationName = "unity.diagnostic")
        {
            Emit("info", "progress", "diagnostic", message, operationId, operationName, 0, 0, null);
        }

        internal static void Warn(string message, string operationId = null, string operationName = "unity.diagnostic")
        {
            Emit("warn", "progress", "diagnostic", message, operationId, operationName, 0, 0, null);
        }

        internal static void Error(string message, Exception error = null, string operationId = null, string operationName = "unity.diagnostic")
        {
            Emit("error", "failed", "diagnostic", message, operationId, operationName, 0, 0, error);
        }

        // 兼容现有 ZLog 别名，让历史模块只改引用即可统一进入 BridgeLogger。
        internal static void Log(string message) => Info(message);
        internal static void LogWarning(string message) => Warn(message);
        internal static void LogError(string message) => Error(message);

        internal static void Clear()
        {
            lock (Sync)
            {
                Events.Clear();
                RecentDisplayLogs.Clear();
            }
            NotifyChanged();
        }

        internal static string QueryJson(NameValueCollection query)
        {
            string source = (query?["source"] ?? string.Empty).Trim();
            string level = (query?["level"] ?? string.Empty).Trim();
            string operationId = (query?["operationId"] ?? string.Empty).Trim();
            string keyword = (query?["keyword"] ?? string.Empty).Trim();
            int limit = ParseBoundedInt(query?["limit"], 1000, 1, 1000);
            int cursor = ParseBoundedInt(query?["cursor"], 0, 0, int.MaxValue);
            var matches = new List<string>();
            if (string.IsNullOrEmpty(source) || string.Equals(source, "unity", StringComparison.OrdinalIgnoreCase))
            {
                List<string> lines = ReadRetainedJsonLines();
                for (int i = 0; i < lines.Count; i++)
                {
                    string line = lines[i];
                    if (!string.IsNullOrEmpty(level) && !HasJsonField(line, "level", level)) continue;
                    if (!string.IsNullOrEmpty(operationId) && !HasJsonField(line, "operationId", operationId)) continue;
                    if (!string.IsNullOrEmpty(keyword)
                        && line.IndexOf(keyword, StringComparison.OrdinalIgnoreCase) < 0
                        && line.IndexOf(Escape(keyword), StringComparison.OrdinalIgnoreCase) < 0) continue;
                    matches.Add(line);
                }
            }

            var json = new StringBuilder(256 + Math.Min(limit, matches.Count) * 192);
            json.Append("{\"events\":[");
            int written = 0;
            for (int i = cursor; i < matches.Count && written < limit; i++, written++)
            {
                if (written > 0) json.Append(',');
                json.Append(matches[i]);
            }
            json.Append("],\"totalMatched\":").Append(matches.Count);
            if (cursor + written < matches.Count)
                json.Append(",\"nextCursor\":").Append(cursor + written);
            json.Append('}');
            return json.ToString();
        }

        private static List<string> ReadRetainedJsonLines()
        {
            var result = new List<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            try
            {
                if (Directory.Exists(LogDirectory))
                {
                    string[] files = Directory.GetFiles(LogDirectory, "unity-*.jsonl");
                    Array.Sort(files, StringComparer.Ordinal);
                    for (int i = 0; i < files.Length; i++)
                    {
                        foreach (string rawLine in File.ReadLines(files[i], Encoding.UTF8))
                        {
                            string line = EscapeRawControlCharacters(rawLine.Trim());
                            if (line.Length > 1 && line[0] == '{' && seen.Add(line)) result.Add(line);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                UnityEngine.Debug.LogWarning("[BridgeLogger] 历史日志读取失败：" + ex.Message);
            }

            lock (Sync)
            {
                for (int i = 0; i < Events.Count; i++)
                {
                    string line = ToJson(Events[i]);
                    if (seen.Add(line)) result.Add(line);
                }
            }
            return result;
        }

        private static bool HasJsonField(string json, string name, string value)
        {
            string expected = "\"" + name + "\":\"" + Escape(value) + "\"";
            return json.IndexOf(expected, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static string EscapeRawControlCharacters(string jsonLine)
        {
            var sanitized = new StringBuilder(jsonLine?.Length ?? 0);
            foreach (char character in jsonLine ?? string.Empty)
            {
                if (character < 0x20)
                {
                    sanitized.Append("\\u");
                    sanitized.Append(((int)character).ToString("x4"));
                }
                else
                {
                    sanitized.Append(character);
                }
            }
            return sanitized.ToString();
        }

        internal static void Emit(
            string level,
            string status,
            string step,
            string message,
            string operationId,
            string operationName,
            int stepIndex,
            long durationMs,
            Exception error)
        {
            var item = new BridgeLogEvent
            {
                Timestamp = DateTime.UtcNow.ToString("O"),
                Level = level,
                OperationId = string.IsNullOrWhiteSpace(operationId) ? "unity-" + Guid.NewGuid().ToString("N") : operationId,
                OperationName = string.IsNullOrWhiteSpace(operationName) ? "unity.diagnostic" : operationName,
                Step = string.IsNullOrWhiteSpace(step) ? "diagnostic" : step,
                StepIndex = Math.Max(0, stepIndex),
                Status = status,
                Message = RedactText(message),
                DurationMs = Math.Max(0, durationMs),
                ErrorName = error?.GetType().Name ?? string.Empty,
                ErrorMessage = error == null ? string.Empty : RedactText(error.Message),
                ErrorStack = error == null ? string.Empty : RedactText(error.ToString())
            };

            lock (Sync)
            {
                Events.Add(item);
                while (Events.Count > MaxMemoryEvents) Events.RemoveAt(0);
                RecentDisplayLogs.Add($"[{DateTime.Now:HH:mm:ss}] {item.Message}");
                while (RecentDisplayLogs.Count > MaxDisplayEvents) RecentDisplayLogs.RemoveAt(0);
                AppendJsonLine(item);
            }

            if (level == "error" || level == "fatal") UnityEngine.Debug.LogError(item.Message);
            else if (level == "warn") UnityEngine.Debug.LogWarning(item.Message);
            else UnityEngine.Debug.Log(item.Message);
            NotifyChanged();
        }

        private static void NotifyChanged()
        {
            Action changed = OnChanged;
            if (changed != null) EditorApplication.delayCall += () => changed();
        }

        private static void AppendJsonLine(BridgeLogEvent item)
        {
            try
            {
                Directory.CreateDirectory(LogDirectory);
                string path = Path.Combine(LogDirectory, "unity-" + DateTime.UtcNow.ToString("yyyy-MM-dd") + ".jsonl");
                File.AppendAllText(path, ToJson(item) + Environment.NewLine, new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                UnityEngine.Debug.LogError("[BridgeLogger] JSONL 写入失败：" + ex.Message);
            }
        }

        private static void CleanupOldFiles()
        {
            try
            {
                if (!Directory.Exists(LogDirectory)) return;
                var files = new List<FileInfo>(new DirectoryInfo(LogDirectory).GetFiles("unity-*.jsonl"));
                DateTime cutoff = DateTime.UtcNow.AddDays(-RetentionDays);
                for (int i = files.Count - 1; i >= 0; i--)
                {
                    if (files[i].LastWriteTimeUtc < cutoff)
                    {
                        files[i].Delete();
                        files.RemoveAt(i);
                    }
                }
                files.Sort((left, right) => right.LastWriteTimeUtc.CompareTo(left.LastWriteTimeUtc));
                long total = 0;
                foreach (FileInfo file in files)
                {
                    total += file.Length;
                    if (total > MaxLogBytes) file.Delete();
                }
            }
            catch (Exception ex)
            {
                UnityEngine.Debug.LogWarning("[BridgeLogger] 日志清理失败：" + ex.Message);
            }
        }

        private static string LogDirectory
        {
            get
            {
                string projectRoot = Path.GetDirectoryName(Application.dataPath) ?? Application.dataPath;
                return Path.Combine(projectRoot, "Library", "figma-bridge-logs");
            }
        }

        private static string ToJson(BridgeLogEvent item)
        {
            var json = new StringBuilder(512);
            json.Append("{\"timestamp\":\"").Append(Escape(item.Timestamp)).Append("\",");
            json.Append("\"level\":\"").Append(Escape(item.Level)).Append("\",");
            json.Append(UnitySourceJson).Append(',');
            json.Append("\"module\":\"figma-bridge\",");
            json.Append("\"operationId\":\"").Append(Escape(item.OperationId)).Append("\",");
            json.Append("\"operationName\":\"").Append(Escape(item.OperationName)).Append("\",");
            json.Append("\"step\":\"").Append(Escape(item.Step)).Append("\",");
            json.Append("\"stepIndex\":").Append(item.StepIndex).Append(',');
            json.Append("\"status\":\"").Append(Escape(item.Status)).Append("\",");
            json.Append("\"message\":\"").Append(Escape(item.Message)).Append("\",");
            json.Append("\"durationMs\":").Append(item.DurationMs);
            if (!string.IsNullOrEmpty(item.ErrorMessage))
            {
                json.Append(",\"error\":{\"name\":\"").Append(Escape(item.ErrorName));
                json.Append("\",\"message\":\"").Append(Escape(item.ErrorMessage));
                json.Append("\",\"stack\":\"").Append(Escape(item.ErrorStack)).Append("\"}");
            }
            json.Append('}');
            return json.ToString();
        }

        private static string RedactText(string value)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;
            string result = value;
            string[] names = { "token", "password", "authorization", "apiKey", "secret" };
            for (int i = 0; i < names.Length; i++)
            {
                int start = result.IndexOf(names[i], StringComparison.OrdinalIgnoreCase);
                if (start < 0) continue;
                int separator = result.IndexOfAny(new[] { '=', ':' }, start + names[i].Length);
                if (separator < 0) continue;
                int end = result.IndexOfAny(new[] { ' ', ',', ';', '\r', '\n' }, separator + 1);
                if (end < 0) end = result.Length;
                result = result.Substring(0, separator + 1) + "[REDACTED]" + result.Substring(end);
            }
            return result.Length <= 4096 ? result : result.Substring(0, 4096) + "…[TRUNCATED]";
        }

        private static string Escape(string value)
        {
            var escaped = new StringBuilder(value?.Length ?? 0);
            foreach (char character in value ?? string.Empty)
            {
                switch (character)
                {
                    case '\\': escaped.Append("\\\\"); break;
                    case '"': escaped.Append("\\\""); break;
                    case '\b': escaped.Append("\\b"); break;
                    case '\f': escaped.Append("\\f"); break;
                    case '\n': escaped.Append("\\n"); break;
                    case '\r': escaped.Append("\\r"); break;
                    case '\t': escaped.Append("\\t"); break;
                    default:
                        if (character < 0x20)
                        {
                            escaped.Append("\\u");
                            escaped.Append(((int)character).ToString("x4"));
                        }
                        else
                        {
                            escaped.Append(character);
                        }
                        break;
                }
            }
            return escaped.ToString();
        }

        private static int ParseBoundedInt(string value, int fallback, int minimum, int maximum)
        {
            int parsed;
            if (!int.TryParse(value, out parsed)) return fallback;
            return Math.Max(minimum, Math.Min(maximum, parsed));
        }

        private sealed class BridgeLogEvent
        {
            internal string Timestamp;
            internal string Level;
            internal string OperationId;
            internal string OperationName;
            internal string Step;
            internal int StepIndex;
            internal string Status;
            internal string Message;
            internal long DurationMs;
            internal string ErrorName;
            internal string ErrorMessage;
            internal string ErrorStack;
        }
    }

    /// <summary>按顺序记录 Unity 操作步骤，并保证只产生一个终态。</summary>
    internal sealed class BridgeOperationScope
    {
        private readonly string _operationName;
        private readonly string _operationId;
        private readonly DateTime _startedAt = DateTime.UtcNow;
        private int _stepIndex;
        private bool _terminal;

        internal string OperationId => _operationId;

        internal BridgeOperationScope(string operationName, string operationId)
        {
            _operationName = operationName;
            _operationId = string.IsNullOrWhiteSpace(operationId) ? "unity-" + Guid.NewGuid().ToString("N") : operationId;
            BridgeLogger.Emit("info", "started", "operation.start", "Unity 操作开始", _operationId, _operationName, 0, 0, null);
        }

        internal void Step(string step, string message)
        {
            if (_terminal) return;
            _stepIndex++;
            BridgeLogger.Emit("info", "progress", step, message, _operationId, _operationName, _stepIndex, DurationMs, null);
        }

        internal void Succeed(string message)
        {
            Finish("info", "succeeded", message, null);
        }

        internal void Fail(Exception error, string message)
        {
            Finish("error", "failed", message, error);
        }

        internal void Cancel(string message)
        {
            Finish("warn", "cancelled", message, null);
        }

        private void Finish(string level, string status, string message, Exception error)
        {
            _stepIndex++;
            if (_terminal)
            {
                BridgeLogger.Emit("warn", "progress", "operation.terminal.ignored", "忽略重复 Unity 终态", _operationId, _operationName, _stepIndex, DurationMs, null);
                return;
            }
            _terminal = true;
            BridgeLogger.Emit(level, status, "operation.complete", message, _operationId, _operationName, _stepIndex, DurationMs, error);
        }

        private long DurationMs => Math.Max(0L, (long)(DateTime.UtcNow - _startedAt).TotalMilliseconds);
    }
}
