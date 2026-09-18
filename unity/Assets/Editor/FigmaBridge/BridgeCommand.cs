using System;
using System.Collections.Specialized;

namespace MagicWarrior.Editor.FigmaBridge
{
    internal sealed class BridgeCommand
    {
        internal string Action;
        internal string Method;
        internal string Body;
        internal string OperationId;
        internal Action Started;
        internal NameValueCollection Query = new NameValueCollection();
        internal BridgeCommandResponse Response;
    }

    internal sealed class BridgeCommandResponse
    {
        private readonly Action<int, string, byte[]> _complete;
        private bool _completed;

        internal BridgeCommandResponse(Action<int, string, byte[]> complete)
        {
            _complete = complete;
        }

        internal int StatusCode { get; private set; }

        internal void Complete(int statusCode, string contentType, byte[] body)
        {
            if (_completed) return;
            _completed = true;
            StatusCode = statusCode;
            _complete(statusCode, contentType, body);
        }
    }
}
