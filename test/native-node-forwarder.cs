using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

// Windows test executable standing in for a Node-script fake where the product starts a runtime only from a
// native executable. Runs `<own name>.js` with the interpreter its `#!` line names, as a POSIX kernel runs a
// shebang script: same arguments, the very same standard handles (also when started detached, without a
// console), and the script's exit code.
public static class OpenRigNodeForwarder {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public int cb; public string reserved, desktop, title;
        public int x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
        public short showWindow, reserved2; public IntPtr reserved3, stdInput, stdOutput, stdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation { public IntPtr process, thread; public int processId, threadId; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfo startupInfo, out ProcessInformation information);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr handle, int mask, int flags);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out int exitCode);

    const int STARTF_USESTDHANDLES = 0x100, HANDLE_FLAG_INHERIT = 1;
    const uint CREATE_NO_WINDOW = 0x08000000, INFINITE = 0xFFFFFFFF;

    public static int Main(string[] args) {
        string script = Path.ChangeExtension(Assembly.GetEntryAssembly().Location, ".js");
        string shebang;
        using (StreamReader reader = new StreamReader(script)) shebang = reader.ReadLine() ?? "";
        if (!shebang.StartsWith("#!")) {
            Console.Error.WriteLine("native-node-forwarder: " + script + " has no #! interpreter line");
            return 127;
        }
        string interpreter = shebang.Substring(2).Trim();
        StringBuilder line = new StringBuilder(Quote(interpreter)).Append(' ').Append(Quote(script));
        foreach (string arg in args) line.Append(' ').Append(Quote(arg));
        StartupInfo startup = new StartupInfo();
        startup.cb = Marshal.SizeOf(typeof(StartupInfo));
        startup.flags = STARTF_USESTDHANDLES;
        startup.stdInput = GetStdHandle(-10);
        startup.stdOutput = GetStdHandle(-11);
        startup.stdError = GetStdHandle(-12);
        foreach (IntPtr handle in new[] { startup.stdInput, startup.stdOutput, startup.stdError }) {
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        }
        ProcessInformation child;
        if (!CreateProcess(interpreter, line, IntPtr.Zero, IntPtr.Zero, true, CREATE_NO_WINDOW, IntPtr.Zero, null, ref startup, out child)) {
            Console.Error.WriteLine("native-node-forwarder: cannot start " + interpreter + " (error " + Marshal.GetLastWin32Error() + ")");
            return 127;
        }
        WaitForSingleObject(child.process, INFINITE);
        int exitCode;
        GetExitCodeProcess(child.process, out exitCode);
        return exitCode;
    }

    // The quoting CommandLineToArgvW and the C runtime undo.
    static string Quote(string arg) {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
        StringBuilder quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in arg) {
            if (c == '\\') { backslashes++; continue; }
            quoted.Append('\\', c == '"' ? backslashes * 2 + 1 : backslashes);
            backslashes = 0;
            quoted.Append(c);
        }
        quoted.Append('\\', backslashes * 2).Append('"');
        return quoted.ToString();
    }
}
