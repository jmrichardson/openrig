using System;
using System.IO;
using System.Reflection;

// Provider-free native executable for Windows tests. Never forwards to a real CLI. Prints the
// `<own name>.version` or `<own name>.help` text that writeRuntimeStubs writes beside it from STUBS.
public static class OpenRigTestRuntime {
    public static int Main(string[] args) {
        string sidecar = args.Length == 0 ? null : args[0] == "--version" ? ".version" : args[0] == "--help" ? ".help" : null;
        if (sidecar != null) Console.Out.Write(File.ReadAllText(Path.ChangeExtension(Assembly.GetEntryAssembly().Location, sidecar)));
        return 0;
    }
}
