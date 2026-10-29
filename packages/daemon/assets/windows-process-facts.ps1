param([Parameter(Mandatory=$true)][int]$TargetPid)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
# Query only a process's working directory, image, selected home locators, and key NAMES.
# Never serialize the environment block or any credential value.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class OpenRigProcessFacts {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] bytes, UIntPtr length, out UIntPtr read);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsWow64Process(IntPtr process, out bool wow64);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] static extern UIntPtr VirtualQueryEx(IntPtr process, IntPtr address, out MemoryRegion info, UIntPtr size);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int type, out BasicInformation info, int length, out int returned);
  [StructLayout(LayoutKind.Sequential)] struct BasicInformation { public IntPtr Reserved1, Peb, Reserved2, Reserved3, Pid, ParentPid; }
  [StructLayout(LayoutKind.Sequential)] struct MemoryRegion { public IntPtr Base, AllocationBase; public uint AllocationProtect; public UIntPtr Size; public uint State, Protect, Type; }
  public sealed class Facts { public string cwd, exe; public Dictionary<string,string> env = new Dictionary<string,string>(); public List<string> apiKeyEnvNames = new List<string>(); }
  static byte[] Read(IntPtr process, long address, int length) {
    if (address <= 0 || length < 0 || length > 1048576) throw new InvalidOperationException();
    byte[] bytes = new byte[length]; UIntPtr count;
    if (!ReadProcessMemory(process, new IntPtr(address), bytes, new UIntPtr((uint)length), out count) || count.ToUInt64() != (ulong)length) throw new InvalidOperationException();
    return bytes;
  }
  static bool Locator(string key) { return key == "HOME" || key == "CODEX_HOME" || key == "USERPROFILE"; }
  static string Unicode(IntPtr process, byte[] parameters, int offset) {
    int length = BitConverter.ToUInt16(parameters, offset);
    int maximum = BitConverter.ToUInt16(parameters, offset + 2);
    if ((length & 1) != 0 || length > maximum) throw new InvalidOperationException();
    return length == 0 ? "" : Encoding.Unicode.GetString(Read(process, BitConverter.ToInt64(parameters, offset + 8), length));
  }
  public static Facts ReadFacts(int pid) {
    if (IntPtr.Size != 8 || pid <= 0) throw new InvalidOperationException();
    IntPtr process = OpenProcess(0x410, false, pid);
    if (process == IntPtr.Zero) throw new InvalidOperationException();
    try {
      bool wow64;
      if (!IsWow64Process(process, out wow64) || wow64) throw new InvalidOperationException();
      BasicInformation basic; int returned;
      if (NtQueryInformationProcess(process, 0, out basic, Marshal.SizeOf(typeof(BasicInformation)), out returned) != 0 || returned != Marshal.SizeOf(typeof(BasicInformation)) || basic.Pid.ToInt64() != pid) throw new InvalidOperationException();
      long parametersAddress = BitConverter.ToInt64(Read(process, basic.Peb.ToInt64() + 0x20, 8), 0);
      byte[] parameters = Read(process, parametersAddress, 0x88);
      Facts facts = new Facts();
      facts.cwd = Unicode(process, parameters, 0x38);
      StringBuilder image = new StringBuilder(32768); uint size = (uint)image.Capacity;
      if (!QueryFullProcessImageName(process, 0, image, ref size)) throw new InvalidOperationException();
      facts.exe = image.ToString();
      long environment = BitConverter.ToInt64(parameters, 0x80);
      // Stream each NAME=value entry. Only a home locator's value is copied; any other value,
      // credentials included, never leaves the scrubbed read buffer.
      StringBuilder name = new StringBuilder(), value = new StringBuilder();
      string key = null; bool skip = false, hasValue = false, ended = false; int total = 0;
      while (!ended && total < 1048576) {
        MemoryRegion region;
        if (VirtualQueryEx(process, new IntPtr(environment + total), out region, new UIntPtr((uint)Marshal.SizeOf(typeof(MemoryRegion)))).ToUInt64() == 0 || region.State != 0x1000 || (region.Protect & 0x101) != 0) throw new InvalidOperationException();
        long available = region.Base.ToInt64() + (long)region.Size.ToUInt64() - environment - total;
        int count = (int)Math.Min(Math.Min(available, 65536), 1048576 - total);
        count &= ~1;
        if (count <= 0) throw new InvalidOperationException();
        byte[] bytes = Read(process, environment + total, count);
        try {
          for (int i = 0; i < count; i += 2) {
            char c = (char)(bytes[i] | bytes[i + 1] << 8);
            if (c == '\0') {
              if (key == null && !skip && name.Length == 0) { ended = true; break; }
              if (Locator(key)) facts.env[key] = value.ToString();
              else if ((key == "OPENAI_API_KEY" || key == "CODEX_API_KEY") && hasValue) facts.apiKeyEnvNames.Add(key);
              name.Clear(); value.Clear(); key = null; skip = false; hasValue = false;
            } else if (skip) {
              continue;
            } else if (key != null) {
              hasValue = true;
              if (Locator(key)) value.Append(c);
            } else if (c == '=') {
              // A leading '=' marks a hidden per-drive entry, which has no name.
              if (name.Length == 0) skip = true; else key = name.ToString().ToUpperInvariant();
            } else name.Append(c);
          }
        } finally { Array.Clear(bytes, 0, bytes.Length); }
        total += count;
      }
      if (!ended) throw new InvalidOperationException();
      // Refuse a concurrent environment replacement rather than combine two snapshots.
      if (BitConverter.ToInt64(Read(process, parametersAddress + 0x80, 8), 0) != environment) throw new InvalidOperationException();
      facts.apiKeyEnvNames.Sort(StringComparer.Ordinal);
      return facts;
    } finally { CloseHandle(process); }
  }
}
'@
try {
  [OpenRigProcessFacts]::ReadFacts($TargetPid) | ConvertTo-Json -Compress -Depth 4
} catch {
  # No exception details: process memory and environment contents are private.
  exit 1
}
