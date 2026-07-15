var logEntriesType = typeof(UnityEditor.Editor).Assembly.GetType("UnityEditor.LogEntries");
if (logEntriesType == null)
{
    throw new System.Exception("UnityEditor.LogEntries type not found.");
}

System.Reflection.MethodInfo method = null;
foreach (var item in logEntriesType.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static))
{
    if (item.Name == "GetCountsByType" && item.GetParameters().Length == 3)
    {
        method = item;
        break;
    }
}

if (method == null)
{
    var names = new System.Collections.Generic.List<string>();
    foreach (var item in logEntriesType.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static))
    {
        names.Add(item.Name);
    }

    throw new System.Exception("UnityEditor.LogEntries.GetCountsByType not found. Available methods: " + string.Join(", ", names));
}

var args = new object[] { 0, 0, 0 };
method.Invoke(null, args);
return "error=" + args[0] + "; warning=" + args[1] + "; log=" + args[2];
