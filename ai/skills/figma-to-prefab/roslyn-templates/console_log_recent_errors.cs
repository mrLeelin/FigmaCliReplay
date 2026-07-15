var assembly = typeof(UnityEditor.Editor).Assembly;
var logEntriesType = assembly.GetType("UnityEditor.LogEntries");
var logEntryType = assembly.GetType("UnityEditor.LogEntry");
if (logEntriesType == null || logEntryType == null)
{
    throw new System.Exception("UnityEditor.LogEntries or UnityEditor.LogEntry type not found.");
}

System.Reflection.MethodInfo getCount = null;
System.Reflection.MethodInfo startGetting = null;
System.Reflection.MethodInfo endGetting = null;
System.Reflection.MethodInfo getEntry = null;
foreach (var item in logEntriesType.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static))
{
    var parameterCount = item.GetParameters().Length;
    if (item.Name == "GetCount" && parameterCount == 0)
    {
        getCount = item;
    }
    else if (item.Name == "StartGettingEntries" && parameterCount == 0)
    {
        startGetting = item;
    }
    else if (item.Name == "EndGettingEntries" && parameterCount == 0)
    {
        endGetting = item;
    }
    else if (item.Name == "GetEntryInternal" && parameterCount == 2)
    {
        getEntry = item;
    }
}
if (getCount == null || startGetting == null || endGetting == null || getEntry == null)
{
    throw new System.Exception("Required UnityEditor.LogEntries methods were not found.");
}

var messageField = logEntryType.GetField("message", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
var modeField = logEntryType.GetField("mode", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
var fileField = logEntryType.GetField("file", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
var lineField = logEntryType.GetField("line", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
if (messageField == null || modeField == null)
{
    throw new System.Exception("UnityEditor.LogEntry message or mode field not found.");
}

var count = (int)getCount.Invoke(null, null);
var output = new System.Text.StringBuilder();
output.AppendLine("consoleEntryCount=" + count);
var matched = 0;
var fallback = new System.Collections.Generic.List<string>();
startGetting.Invoke(null, null);
try
{
    var first = System.Math.Max(0, count - 80);
    for (var i = count - 1; i >= first; i--)
    {
        var entry = System.Activator.CreateInstance(logEntryType);
        getEntry.Invoke(null, new object[] { i, entry });
        var message = (messageField.GetValue(entry) as string) ?? string.Empty;
        var mode = modeField.GetValue(entry);
        var file = fileField == null ? string.Empty : ((fileField.GetValue(entry) as string) ?? string.Empty);
        var line = lineField == null ? 0 : (int)lineField.GetValue(entry);
        var oneLineMessage = message.Replace("\r", " ").Replace("\n", " ");
        if (oneLineMessage.Length > 500)
        {
            oneLineMessage = oneLineMessage.Substring(0, 500) + "...";
        }

        var item = "[" + i + "] mode=" + mode + " " + file + ":" + line + " " + oneLineMessage;
        if (fallback.Count < 10)
        {
            fallback.Add(item);
        }

        var lower = oneLineMessage.ToLowerInvariant();
        if (lower.Contains("exception") || lower.Contains("error") || lower.Contains("failed") || lower.Contains("missingreference") || lower.Contains("nullreference"))
        {
            output.AppendLine(item);
            matched++;
            if (matched >= 20)
            {
                break;
            }
        }
    }
}
finally
{
    endGetting.Invoke(null, null);
}

if (matched == 0)
{
    output.AppendLine("No keyword-matched recent errors. Last entries:");
    foreach (var item in fallback)
    {
        output.AppendLine(item);
    }
}

return output.ToString();
