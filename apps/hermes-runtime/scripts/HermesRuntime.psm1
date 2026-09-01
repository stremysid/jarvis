Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($null -ne ('HermesRuntime.NativeFileGuard' -as [type])) { throw 'Hermes native filesystem types are already loaded; start a fresh PowerShell process.' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace HermesRuntime {
  public sealed class NativeFileGuard : IDisposable {
    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION {
      public uint FileAttributes;
      public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
      public uint VolumeSerialNumber;
      public uint FileSizeHigh;
      public uint FileSizeLow;
      public uint NumberOfLinks;
      public uint FileIndexHigh;
      public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_DISPOSITION_INFO {
      [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_BASIC_INFO {
      public long CreationTime;
      public long LastAccessTime;
      public long LastWriteTime;
      public long ChangeTime;
      public uint FileAttributes;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, System.Text.StringBuilder path, uint pathLength, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, IntPtr information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, ref FILE_DISPOSITION_INFO information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, ref FILE_BASIC_INFO information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, IntPtr information, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileExW(string existingName, string newName, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateDirectoryW(string path, IntPtr securityAttributes);

    private readonly SafeFileHandle handle;
    public uint Attributes { get; private set; }
    public uint LinkCount { get; private set; }
    public ulong Size { get; private set; }
    public string Identity { get; private set; }
    public string[] Streams { get; private set; }
    public bool MoveCapable { get; private set; }

    private static string NativePath(string path) {
      return path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path : @"\\?\" + path;
    }

    private static string[] ReadStreams(SafeFileHandle fileHandle) {
      const int FileStreamInfo = 7;
      const int ERROR_MORE_DATA = 234;
      const int ERROR_HANDLE_EOF = 38;
      int size = 65536;
      while (size <= 1048576) {
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
          if (!GetFileInformationByHandleEx(fileHandle, FileStreamInfo, buffer, (uint)size)) {
            int error = Marshal.GetLastWin32Error();
            if (error == ERROR_MORE_DATA) { size *= 2; continue; }
            if (error == ERROR_HANDLE_EOF) return new string[0];
            throw new Win32Exception(error, "Unable to enumerate filesystem streams through the identity handle.");
          }
          var streams = new List<string>();
          int offset = 0;
          while (true) {
            if (offset < 0 || offset > size - 24) throw new InvalidOperationException("Filesystem stream metadata is malformed.");
            int next = Marshal.ReadInt32(buffer, offset);
            int nameBytes = Marshal.ReadInt32(buffer, offset + 4);
            if (nameBytes < 0 || (nameBytes & 1) != 0 || offset + 24 + nameBytes > size) throw new InvalidOperationException("Filesystem stream metadata is malformed.");
            streams.Add(Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 24), nameBytes / 2));
            if (next == 0) return streams.ToArray();
            if (next < 24 || offset + next <= offset) throw new InvalidOperationException("Filesystem stream metadata is malformed.");
            offset += next;
          }
        } finally { Marshal.FreeHGlobal(buffer); }
      }
      throw new InvalidOperationException("Filesystem stream metadata exceeds the closed validation bound.");
    }

    private NativeFileGuard(string path, uint access, uint share, uint creation) : this(path, access, share, creation, 0) { }

    private NativeFileGuard(string path, uint access, uint share, uint creation, uint extraFlags) {
      const uint FILE_READ_ATTRIBUTES = 0x80;
      const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
      const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
      handle = CreateFileW(NativePath(path), access | FILE_READ_ATTRIBUTES, share, IntPtr.Zero, creation, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS | extraFlags, IntPtr.Zero);
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to open a no-follow filesystem identity handle.");
      try {
        BY_HANDLE_FILE_INFORMATION info;
        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to read filesystem identity.");
        Attributes = info.FileAttributes;
        LinkCount = info.NumberOfLinks;
        Size = ((ulong)info.FileSizeHigh << 32) | info.FileSizeLow;
        Identity = info.VolumeSerialNumber.ToString("x8") + ":" + info.FileIndexHigh.ToString("x8") + info.FileIndexLow.ToString("x8");
        Streams = ReadStreams(handle);
      } catch { handle.Dispose(); throw; }
    }

    public static NativeFileGuard Open(string path) {
      const uint FILE_SHARE_READ = 0x1;
      const uint OPEN_EXISTING = 3;
      return new NativeFileGuard(path, 0, FILE_SHARE_READ, OPEN_EXISTING);
    }
    public static NativeFileGuard OpenReadOnlySnapshot(string path) {
      const uint GENERIC_READ = 0x80000000;
      const uint FILE_SHARE_READ = 0x1;
      const uint OPEN_EXISTING = 3;
      return new NativeFileGuard(path, GENERIC_READ, FILE_SHARE_READ, OPEN_EXISTING);
    }
    public static NativeFileGuard OpenObservation(string path) {
      const uint FILE_SHARE_READ = 0x1;
      const uint FILE_SHARE_WRITE = 0x2;
      const uint FILE_SHARE_DELETE = 0x4;
      const uint OPEN_EXISTING = 3;
      return new NativeFileGuard(path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, OPEN_EXISTING);
    }
    public static NativeFileGuard OpenDirectoryLease(string path) {
      const uint FILE_LIST_DIRECTORY = 0x0001;
      const uint FILE_SHARE_READ = 0x1;
      const uint OPEN_EXISTING = 3;
      return new NativeFileGuard(path, FILE_LIST_DIRECTORY, FILE_SHARE_READ, OPEN_EXISTING);
    }
    public static NativeFileGuard OpenMovableDirectoryLease(string path) {
      const uint FILE_LIST_DIRECTORY = 0x0001;
      const uint DELETE = 0x00010000;
      const uint FILE_SHARE_READ = 0x1;
      const uint OPEN_EXISTING = 3;
      const uint FILE_FLAG_WRITE_THROUGH = 0x80000000;
      var guard = new NativeFileGuard(path, FILE_LIST_DIRECTORY | DELETE, FILE_SHARE_READ, OPEN_EXISTING, FILE_FLAG_WRITE_THROUGH);
      guard.MoveCapable = true;
      return guard;
    }
    public static NativeFileGuard OpenGitWritableDirectoryLease(string path, bool moveCapable) {
      const uint FILE_LIST_DIRECTORY = 0x0001;
      const uint FILE_SHARE_READ = 0x1;
      const uint FILE_SHARE_WRITE = 0x2;
      const uint FILE_SHARE_DELETE = 0x4;
      const uint OPEN_EXISTING = 3;
      var guard = new NativeFileGuard(path, FILE_LIST_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, OPEN_EXISTING);
      guard.MoveCapable = moveCapable;
      return guard;
    }
    public static NativeFileGuard CreateAnchorFile(string path) {
      const uint GENERIC_READ = 0x80000000;
      const uint GENERIC_WRITE = 0x40000000;
      const uint DELETE = 0x00010000;
      const uint FILE_SHARE_READ = 0x1;
      const uint CREATE_NEW = 1;
      const uint FILE_FLAG_DELETE_ON_CLOSE = 0x04000000;
      const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;
      const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
      var guard = new NativeFileGuard(path, GENERIC_READ | GENERIC_WRITE | DELETE, FILE_SHARE_READ, CREATE_NEW, FILE_FLAG_DELETE_ON_CLOSE);
      bool unsafeStream = false;
      foreach (string stream in guard.Streams) if (!String.Equals(stream, "::$DATA", StringComparison.Ordinal)) unsafeStream = true;
      if ((guard.Attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 || guard.LinkCount != 1 || guard.Size != 0 || unsafeStream) {
        guard.Dispose();
        throw new InvalidOperationException("Hermes containment anchor is not an exact empty regular no-follow file.");
      }
      return guard;
    }
    public static void CreateDirectoryNew(string path) {
      if (!CreateDirectoryW(NativePath(path), IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Atomic contained directory creation failed.");
    }
    public static NativeFileGuard OpenDeleteGuard(string path) {
      const uint DELETE = 0x00010000;
      const uint FILE_WRITE_ATTRIBUTES = 0x0100;
      const uint FILE_SHARE_READ = 0x1;
      const uint FILE_SHARE_WRITE = 0x2;
      const uint OPEN_EXISTING = 3;
      return new NativeFileGuard(path, DELETE | FILE_WRITE_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, OPEN_EXISTING);
    }
    public static NativeFileGuard OpenWorkflowLock(string path) {
      const uint GENERIC_READ = 0x80000000;
      const uint GENERIC_WRITE = 0x40000000;
      const uint OPEN_ALWAYS = 4;
      const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;
      const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
      var guard = new NativeFileGuard(path, GENERIC_READ | GENERIC_WRITE, 0, OPEN_ALWAYS);
      bool unsafeStream = false;
      foreach (string stream in guard.Streams) if (!String.Equals(stream, "::$DATA", StringComparison.Ordinal)) unsafeStream = true;
      if ((guard.Attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 || guard.LinkCount != 1 || guard.Size != 0 || unsafeStream) {
        guard.Dispose();
        throw new InvalidOperationException("Hermes workflow lock is not an exact empty regular no-follow file.");
      }
      return guard;
    }
    public static void DurableMoveNoReplace(string source, string destination) {
      const uint MOVEFILE_WRITE_THROUGH = 0x8;
      if (!MoveFileExW(NativePath(source), NativePath(destination), MOVEFILE_WRITE_THROUGH)) {
        int error = Marshal.GetLastWin32Error();
        throw new Win32Exception(error, "Durable no-replace move failed (Win32 " + error.ToString() + ").");
      }
    }
    public string GetCanonicalPath() {
      var path = new System.Text.StringBuilder(32768);
      uint length = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, 0);
      if (length == 0 || length >= path.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to resolve the canonical handle path.");
      return path.ToString();
    }
    public void MoveToNoReplace(string destination) {
      const int FileRenameInfo = 3;
      string full = System.IO.Path.GetFullPath(destination);
      byte[] name = System.Text.Encoding.Unicode.GetBytes(full + "\0");
      int fileNameLength = name.Length - sizeof(char);
      int rootOffset = IntPtr.Size == 8 ? 8 : 4;
      int lengthOffset = rootOffset + IntPtr.Size;
      int nameOffset = lengthOffset + 4;
      int bufferSize = checked(nameOffset + name.Length);
      IntPtr buffer = Marshal.AllocHGlobal(bufferSize);
      try {
        byte[] zero = new byte[bufferSize];
        Marshal.Copy(zero, 0, buffer, zero.Length);
        Marshal.WriteInt32(buffer, 0, 0);
        Marshal.WriteIntPtr(buffer, rootOffset, IntPtr.Zero);
        Marshal.WriteInt32(buffer, lengthOffset, fileNameLength);
        Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
        if (!SetFileInformationByHandle(handle, FileRenameInfo, buffer, (uint)bufferSize)) {
          int error = Marshal.GetLastWin32Error();
          throw new Win32Exception(error, "Identity-bound no-replace directory move failed (Win32 " + error.ToString() + ").");
        }
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    public void DeleteByHandle() {
      const int FileBasicInfo = 0;
      const int FileDispositionInfo = 4;
      const uint FILE_ATTRIBUTE_READONLY = 0x1;
      const uint FILE_ATTRIBUTE_NORMAL = 0x80;
      if ((Attributes & FILE_ATTRIBUTE_READONLY) != 0) {
        uint writableAttributes = Attributes & ~FILE_ATTRIBUTE_READONLY;
        if (writableAttributes == 0) writableAttributes = FILE_ATTRIBUTE_NORMAL;
        var basic = new FILE_BASIC_INFO { FileAttributes = writableAttributes };
        if (!SetFileInformationByHandle(handle, FileBasicInfo, ref basic, (uint)Marshal.SizeOf(typeof(FILE_BASIC_INFO)))) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to clear the read-only attribute through the deletion identity handle.");
        BY_HANDLE_FILE_INFORMATION refreshed;
        if (!GetFileInformationByHandle(handle, out refreshed)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to revalidate filesystem identity attributes before deletion.");
        Attributes = refreshed.FileAttributes;
        if ((Attributes & FILE_ATTRIBUTE_READONLY) != 0) throw new InvalidOperationException("Deletion identity remained read-only after the identity-bound attribute transition.");
      }
      var disposition = new FILE_DISPOSITION_INFO { DeleteFile = true };
      if (!SetFileInformationByHandle(handle, FileDispositionInfo, ref disposition, (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO)))) throw new Win32Exception(Marshal.GetLastWin32Error(), "No-follow filesystem deletion failed.");
    }
    public void Dispose() { handle.Dispose(); }
  }

  public sealed class NativeAtomicStateFile : IDisposable {
    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION {
      public uint FileAttributes;
      public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
      public uint VolumeSerialNumber;
      public uint FileSizeHigh;
      public uint FileSizeLow;
      public uint NumberOfLinks;
      public uint FileIndexHigh;
      public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILE_DISPOSITION_INFO {
      [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out BY_HANDLE_FILE_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, IntPtr information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(SafeFileHandle handle, IntPtr buffer, uint bytesToWrite, out uint bytesWritten, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(SafeFileHandle handle, IntPtr buffer, uint bytesToRead, out uint bytesRead, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFilePointerEx(SafeFileHandle handle, long distance, out long newPosition, uint moveMethod);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetEndOfFile(SafeFileHandle handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FlushFileBuffers(SafeFileHandle handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, IntPtr information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, ref FILE_DISPOSITION_INFO information, uint size);

    private readonly SafeFileHandle handle;
    public uint Attributes { get; private set; }
    public uint LinkCount { get; private set; }
    public ulong Size { get; private set; }
    public string Identity { get; private set; }
    public string[] Streams { get; private set; }

    private static string NativePath(string path) {
      return path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path : @"\\?\" + path;
    }

    private static string[] ReadStreams(SafeFileHandle fileHandle) {
      const int FileStreamInfo = 7;
      const int ERROR_MORE_DATA = 234;
      const int ERROR_HANDLE_EOF = 38;
      int size = 65536;
      while (size <= 1048576) {
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
          if (!GetFileInformationByHandleEx(fileHandle, FileStreamInfo, buffer, (uint)size)) {
            int error = Marshal.GetLastWin32Error();
            if (error == ERROR_MORE_DATA) { size *= 2; continue; }
            if (error == ERROR_HANDLE_EOF) return new string[0];
            throw new Win32Exception(error, "Unable to enumerate atomic state streams through the identity handle.");
          }
          var streams = new List<string>();
          int offset = 0;
          while (true) {
            if (offset < 0 || offset > size - 24) throw new InvalidOperationException("Atomic state stream metadata is malformed.");
            int next = Marshal.ReadInt32(buffer, offset);
            int nameBytes = Marshal.ReadInt32(buffer, offset + 4);
            if (nameBytes < 0 || (nameBytes & 1) != 0 || offset + 24 + nameBytes > size) throw new InvalidOperationException("Atomic state stream metadata is malformed.");
            streams.Add(Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 24), nameBytes / 2));
            if (next == 0) return streams.ToArray();
            if (next < 24 || offset + next <= offset) throw new InvalidOperationException("Atomic state stream metadata is malformed.");
            offset += next;
          }
        } finally { Marshal.FreeHGlobal(buffer); }
      }
      throw new InvalidOperationException("Atomic state stream metadata exceeds the closed validation bound.");
    }

    private NativeAtomicStateFile(SafeFileHandle stateHandle) {
      handle = stateHandle;
      Refresh();
      AssertSafe(0);
    }

    private void Refresh() {
      BY_HANDLE_FILE_INFORMATION info;
      if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to read atomic state identity.");
      Attributes = info.FileAttributes;
      LinkCount = info.NumberOfLinks;
      Size = ((ulong)info.FileSizeHigh << 32) | info.FileSizeLow;
      Identity = info.VolumeSerialNumber.ToString("x8") + ":" + info.FileIndexHigh.ToString("x8") + info.FileIndexLow.ToString("x8");
      Streams = ReadStreams(handle);
    }

    private void AssertSafe(ulong expectedSize) {
      const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;
      const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
      bool unsafeStream = false;
      foreach (string stream in Streams) if (!String.Equals(stream, "::$DATA", StringComparison.Ordinal)) unsafeStream = true;
      if ((Attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 || LinkCount != 1 || Size != expectedSize || unsafeStream) {
        throw new InvalidOperationException("Atomic state file is not the exact safe regular object.");
      }
    }

    public static NativeAtomicStateFile CreateNew(string path) {
      const uint GENERIC_READ = 0x80000000;
      const uint GENERIC_WRITE = 0x40000000;
      const uint DELETE = 0x00010000;
      const uint FILE_READ_ATTRIBUTES = 0x80;
      const uint FILE_SHARE_READ = 0x1;
      const uint CREATE_NEW = 1;
      const uint FILE_ATTRIBUTE_NORMAL = 0x80;
      const uint FILE_FLAG_WRITE_THROUGH = 0x80000000;
      const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
      SafeFileHandle stateHandle = CreateFileW(NativePath(path), GENERIC_READ | GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES, FILE_SHARE_READ, IntPtr.Zero, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
      if (stateHandle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create the atomic state file.");
      try { return new NativeAtomicStateFile(stateHandle); } catch { stateHandle.Dispose(); throw; }
    }

    private static void Transfer(SafeFileHandle fileHandle, byte[] bytes, bool write) {
      if (bytes == null) throw new ArgumentNullException("bytes");
      GCHandle pinned = default(GCHandle);
      try {
        if (bytes.Length > 0) pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        int offset = 0;
        while (offset < bytes.Length) {
          uint count = (uint)Math.Min(1048576, bytes.Length - offset);
          uint transferred;
          bool ok = write
            ? WriteFile(fileHandle, IntPtr.Add(pinned.AddrOfPinnedObject(), offset), count, out transferred, IntPtr.Zero)
            : ReadFile(fileHandle, IntPtr.Add(pinned.AddrOfPinnedObject(), offset), count, out transferred, IntPtr.Zero);
          if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), write ? "Unable to write atomic state bytes." : "Unable to read atomic state bytes.");
          if (transferred == 0 || transferred > count) throw new InvalidOperationException(write ? "Atomic state write made no bounded progress." : "Atomic state read was truncated.");
          offset += checked((int)transferred);
        }
      } finally { if (pinned.IsAllocated) pinned.Free(); }
    }

    private void SeekStart() {
      const uint FILE_BEGIN = 0;
      long position;
      if (!SetFilePointerEx(handle, 0, out position, FILE_BEGIN) || position != 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to seek the atomic state handle.");
    }

    public void WriteExact(byte[] bytes) {
      SeekStart();
      Transfer(handle, bytes, true);
      if (!SetEndOfFile(handle)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to set the atomic state length.");
      if (!FlushFileBuffers(handle)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to flush the atomic state file.");
      Refresh();
      AssertSafe((ulong)bytes.LongLength);
      if (!Matches(bytes)) throw new InvalidOperationException("Atomic state bytes changed through the creation handle.");
    }

    public bool Matches(byte[] expected) {
      Refresh();
      AssertSafe((ulong)expected.LongLength);
      byte[] actual = new byte[expected.Length];
      SeekStart();
      Transfer(handle, actual, false);
      int difference = 0;
      for (int index = 0; index < expected.Length; index++) difference |= actual[index] ^ expected[index];
      return difference == 0;
    }

    public void MoveToNoReplace(string destination) {
      const int FileRenameInfo = 3;
      string full = System.IO.Path.GetFullPath(destination);
      byte[] name = System.Text.Encoding.Unicode.GetBytes(full + "\0");
      int fileNameLength = name.Length - sizeof(char);
      int rootOffset = IntPtr.Size == 8 ? 8 : 4;
      int lengthOffset = rootOffset + IntPtr.Size;
      int nameOffset = lengthOffset + 4;
      int bufferSize = checked(nameOffset + name.Length);
      IntPtr buffer = Marshal.AllocHGlobal(bufferSize);
      try {
        byte[] zero = new byte[bufferSize];
        Marshal.Copy(zero, 0, buffer, zero.Length);
        Marshal.WriteInt32(buffer, 0, 0);
        Marshal.WriteIntPtr(buffer, rootOffset, IntPtr.Zero);
        Marshal.WriteInt32(buffer, lengthOffset, fileNameLength);
        Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
        if (!SetFileInformationByHandle(handle, FileRenameInfo, buffer, (uint)bufferSize)) {
          int error = Marshal.GetLastWin32Error();
          throw new Win32Exception(error, "Atomic no-replace state move failed (Win32 " + error.ToString() + ").");
        }
      } finally { Marshal.FreeHGlobal(buffer); }
      Refresh();
    }

    public void DeleteByHandle() {
      const int FileDispositionInfo = 4;
      var disposition = new FILE_DISPOSITION_INFO { DeleteFile = true };
      if (!SetFileInformationByHandle(handle, FileDispositionInfo, ref disposition, (uint)Marshal.SizeOf(typeof(FILE_DISPOSITION_INFO)))) throw new Win32Exception(Marshal.GetLastWin32Error(), "Atomic state cleanup failed.");
    }

    public void Dispose() { handle.Dispose(); }
  }
}
'@

if ($null -ne ('HermesRuntime.NativeProcessRunner' -as [type])) { throw 'Hermes native process types are already loaded; start a fresh PowerShell process.' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace HermesRuntime {
  public sealed class NativeProcessResult {
    public int ExitCode { get; private set; }
    public byte[] Stdout { get; private set; }
    public string Stderr { get; private set; }

    internal NativeProcessResult(int exitCode, byte[] stdout, string stderr) {
      ExitCode = exitCode;
      Stdout = stdout;
      Stderr = stderr;
    }
  }

  public static class NativeProcessRunner {
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const long PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    private const long PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_FAILED = 0xffffffff;
    private const uint INFINITE = 0xffffffff;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES {
      public int nLength;
      public IntPtr lpSecurityDescriptor;
      [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO {
      public uint cb;
      public IntPtr lpReserved;
      public IntPtr lpDesktop;
      public IntPtr lpTitle;
      public uint dwX;
      public uint dwY;
      public uint dwXSize;
      public uint dwYSize;
      public uint dwXCountChars;
      public uint dwYCountChars;
      public uint dwFillAttribute;
      public uint dwFlags;
      public ushort wShowWindow;
      public ushort cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX {
      public STARTUPINFO StartupInfo;
      public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public uint dwProcessId;
      public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObjectW(IntPtr jobAttributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out SafeFileHandle readPipe, out SafeFileHandle writePipe, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr attributeList, int attributeCount, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(SafeWaitHandle thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeWaitHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(SafeWaitHandle process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);

    private static string QuoteArgument(string argument) {
      if (argument == null) throw new ArgumentNullException("argument");
      if (argument.IndexOf('\0') >= 0) throw new ArgumentException("Process arguments must not contain NUL.", "argument");
      if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return argument;
      var quoted = new StringBuilder(argument.Length + 2);
      quoted.Append('"');
      int backslashes = 0;
      foreach (char character in argument) {
        if (character == '\\') {
          backslashes++;
        } else if (character == '"') {
          quoted.Append('\\', backslashes * 2 + 1);
          quoted.Append('"');
          backslashes = 0;
        } else {
          quoted.Append('\\', backslashes);
          quoted.Append(character);
          backslashes = 0;
        }
      }
      quoted.Append('\\', backslashes * 2);
      quoted.Append('"');
      return quoted.ToString();
    }

    private static StringBuilder BuildCommandLine(string application, string[] arguments) {
      var commandLine = new StringBuilder(QuoteArgument(application));
      foreach (string argument in arguments) {
        commandLine.Append(' ');
        commandLine.Append(QuoteArgument(argument));
      }
      if (commandLine.Length > 32766) throw new InvalidOperationException("Closed process command line exceeds the Windows bound.");
      return commandLine;
    }

    private static IntPtr BuildEnvironmentBlock(IDictionary<string, string> environment) {
      if (environment == null || environment.Count == 0) throw new InvalidOperationException("Closed process environment is absent.");
      var entries = new List<KeyValuePair<string, string>>(environment);
      entries.Sort(delegate(KeyValuePair<string, string> left, KeyValuePair<string, string> right) {
        int folded = StringComparer.OrdinalIgnoreCase.Compare(left.Key, right.Key);
        return folded != 0 ? folded : StringComparer.Ordinal.Compare(left.Key, right.Key);
      });
      var block = new StringBuilder();
      foreach (KeyValuePair<string, string> entry in entries) {
        if (String.IsNullOrEmpty(entry.Key) || entry.Key.IndexOf('=') >= 0 || entry.Key.IndexOf('\0') >= 0 || entry.Value == null || entry.Value.IndexOf('\0') >= 0) throw new InvalidOperationException("Closed process environment contains an unsafe entry.");
        block.Append(entry.Key);
        block.Append('=');
        block.Append(entry.Value);
        block.Append('\0');
      }
      block.Append('\0');
      return Marshal.StringToHGlobalUni(block.ToString());
    }

    private static void ThrowLastError(string message) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), message);
    }

    public static NativeProcessResult Run(string application, string[] arguments, IDictionary<string, string> environment, string currentDirectory) {
      if (String.IsNullOrEmpty(application) || application.IndexOf('\0') >= 0 || !Path.IsPathRooted(application)) throw new InvalidOperationException("Closed process application path is invalid.");
      if (arguments == null) throw new ArgumentNullException("arguments");
      if (String.IsNullOrEmpty(currentDirectory) || currentDirectory.IndexOf('\0') >= 0 || !Path.IsPathRooted(currentDirectory)) throw new InvalidOperationException("Closed process working directory is invalid.");

      SafeFileHandle job = null;
      SafeFileHandle stdoutRead = null;
      SafeFileHandle stdoutWrite = null;
      SafeFileHandle stderrRead = null;
      SafeFileHandle stderrWrite = null;
      SafeFileHandle stdinNull = null;
      SafeWaitHandle process = null;
      SafeWaitHandle thread = null;
      IntPtr attributeList = IntPtr.Zero;
      bool attributeListInitialized = false;
      IntPtr jobList = IntPtr.Zero;
      IntPtr handleList = IntPtr.Zero;
      IntPtr environmentBlock = IntPtr.Zero;
      bool childCreated = false;
      try {
        job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == null || job.IsInvalid) ThrowLastError("Unable to create the closed Git process job.");
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) ThrowLastError("Unable to configure kill-on-close for the closed Git process job.");

        var inheritable = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), lpSecurityDescriptor = IntPtr.Zero, bInheritHandle = true };
        if (!CreatePipe(out stdoutRead, out stdoutWrite, ref inheritable, 0)) ThrowLastError("Unable to create the closed Git stdout pipe.");
        if (!SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0)) ThrowLastError("Unable to protect the closed Git stdout reader from inheritance.");
        if (!CreatePipe(out stderrRead, out stderrWrite, ref inheritable, 0)) ThrowLastError("Unable to create the closed Git stderr pipe.");
        if (!SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0)) ThrowLastError("Unable to protect the closed Git stderr reader from inheritance.");
        const uint GENERIC_READ = 0x80000000;
        const uint FILE_SHARE_READ = 0x1;
        const uint FILE_SHARE_WRITE = 0x2;
        const uint OPEN_EXISTING = 3;
        const uint FILE_ATTRIBUTE_NORMAL = 0x80;
        stdinNull = CreateFileW("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (stdinNull == null || stdinNull.IsInvalid) ThrowLastError("Unable to create the closed Git stdin handle.");

        IntPtr attributeBytes = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeBytes);
        if (attributeBytes == IntPtr.Zero) ThrowLastError("Unable to size the closed Git process attribute list.");
        attributeList = Marshal.AllocHGlobal(attributeBytes);
        if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref attributeBytes)) ThrowLastError("Unable to initialize the closed Git process attribute list.");
        attributeListInitialized = true;

        jobList = Marshal.AllocHGlobal(IntPtr.Size);
        Marshal.WriteIntPtr(jobList, job.DangerousGetHandle());
        if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) ThrowLastError("Unable to bind the closed Git process to its job at creation.");

        handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
        Marshal.WriteIntPtr(handleList, 0, stdinNull.DangerousGetHandle());
        Marshal.WriteIntPtr(handleList, IntPtr.Size, stdoutWrite.DangerousGetHandle());
        Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, stderrWrite.DangerousGetHandle());
        if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handleList, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) ThrowLastError("Unable to restrict the closed Git process handle inheritance.");

        environmentBlock = BuildEnvironmentBlock(environment);
        var commandLine = BuildCommandLine(application, arguments);
        var startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdinNull.DangerousGetHandle();
        startup.StartupInfo.hStdOutput = stdoutWrite.DangerousGetHandle();
        startup.StartupInfo.hStdError = stderrWrite.DangerousGetHandle();
        startup.lpAttributeList = attributeList;
        PROCESS_INFORMATION created;
        uint creationFlags = CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
        if (!CreateProcessW(application, commandLine, IntPtr.Zero, IntPtr.Zero, true, creationFlags, environmentBlock, currentDirectory, ref startup, out created)) ThrowLastError("Unable to create the closed Git process inside its job.");
        childCreated = true;
        process = new SafeWaitHandle(created.hProcess, true);
        thread = new SafeWaitHandle(created.hThread, true);
        GC.KeepAlive(job);
        GC.KeepAlive(stdinNull);
        GC.KeepAlive(stdoutWrite);
        GC.KeepAlive(stderrWrite);

        stdinNull.Dispose(); stdinNull = null;
        stdoutWrite.Dispose(); stdoutWrite = null;
        stderrWrite.Dispose(); stderrWrite = null;
        if (attributeListInitialized) { DeleteProcThreadAttributeList(attributeList); attributeListInitialized = false; }
        Marshal.FreeHGlobal(attributeList); attributeList = IntPtr.Zero;
        Marshal.FreeHGlobal(jobList); jobList = IntPtr.Zero;
        Marshal.FreeHGlobal(handleList); handleList = IntPtr.Zero;
        Marshal.FreeHGlobal(environmentBlock); environmentBlock = IntPtr.Zero;

        using (var stdoutStream = new FileStream(stdoutRead, FileAccess.Read, 65536, false))
        using (var stderrStream = new FileStream(stderrRead, FileAccess.Read, 65536, false))
        using (var output = new MemoryStream())
        using (var stderrReader = new StreamReader(stderrStream, new UTF8Encoding(false, false), true, 4096, true)) {
          stdoutRead = null;
          stderrRead = null;
          var stdoutTask = Task.Run(delegate { stdoutStream.CopyTo(output); });
          var stderrTask = Task.Run<string>(delegate { return stderrReader.ReadToEnd(); });
          if (ResumeThread(thread) == UInt32.MaxValue) ThrowLastError("Unable to resume the closed Git process inside its job.");
          thread.Dispose(); thread = null;
          uint wait = WaitForSingleObject(process, INFINITE);
          if (wait == WAIT_FAILED) ThrowLastError("Unable to wait for the closed Git process.");
          if (wait != WAIT_OBJECT_0) throw new InvalidOperationException("Closed Git process wait returned an unexpected state.");
          uint nativeExitCode;
          if (!GetExitCodeProcess(process, out nativeExitCode)) ThrowLastError("Unable to read the closed Git process exit code.");
          job.Dispose(); job = null;
          stdoutTask.GetAwaiter().GetResult();
          string stderr = stderrTask.GetAwaiter().GetResult();
          return new NativeProcessResult(unchecked((int)nativeExitCode), output.ToArray(), stderr);
        }
      } finally {
        if (job != null && !job.IsInvalid && !job.IsClosed) {
          if (childCreated) { TerminateJobObject(job, 1); }
          job.Dispose();
        }
        if (process != null) { if (!process.IsInvalid && !process.IsClosed) { WaitForSingleObject(process, 5000); } process.Dispose(); }
        if (thread != null) thread.Dispose();
        if (stdinNull != null) stdinNull.Dispose();
        if (stdoutWrite != null) stdoutWrite.Dispose();
        if (stderrWrite != null) stderrWrite.Dispose();
        if (stdoutRead != null) stdoutRead.Dispose();
        if (stderrRead != null) stderrRead.Dispose();
        if (attributeListInitialized) DeleteProcThreadAttributeList(attributeList);
        if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
        if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
        if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
        if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
      }
    }
  }
}
'@

function Assert-LiteralRuntimeRoot {
  param([string]$RuntimeRoot)
  if ([string]::IsNullOrWhiteSpace($RuntimeRoot) -or $RuntimeRoot.EndsWith('\') -or $RuntimeRoot.StartsWith('\\') -or $RuntimeRoot.StartsWith('//') -or $RuntimeRoot -match '^(\\\\[?.]\\|[A-Za-z]:[^\\]|[^A-Za-z])' -or $RuntimeRoot.Contains('/')) { throw 'RuntimeRoot must be an exact drive-absolute non-device local path without a trailing separator.' }
  $full = [IO.Path]::GetFullPath($RuntimeRoot)
  if (-not [IO.Path]::IsPathFullyQualified($full) -or [IO.Path]::GetPathRoot($full) -eq $full -or -not $RuntimeRoot.Equals($full, [StringComparison]::Ordinal)) { throw 'RuntimeRoot must be a bounded canonical local child path without relative or alias segments.' }
  if (Test-UnsafeArchiveMember $full.Substring(3)) { throw 'RuntimeRoot contains an unsafe Windows path component.' }
  $pathRoot = [IO.Path]::GetPathRoot($full)
  $drive = [IO.DriveInfo]::new($pathRoot)
  if ($drive.DriveType -ne [IO.DriveType]::Fixed -or -not $pathRoot.Equals($drive.Name, [StringComparison]::Ordinal)) { throw 'RuntimeRoot must reside on the exact canonical local fixed drive.' }
  if ($drive.DriveFormat -ne 'NTFS') { throw 'RuntimeRoot must reside on NTFS for identity and alternate-stream enforcement.' }
  $cursor = $full
  while ($true) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'RuntimeRoot must not traverse a reparse point.' }
    }
    $parentInfo = [IO.Directory]::GetParent($cursor)
    $parent = if ($null -eq $parentInfo) { '' } else { $parentInfo.FullName }
    if ($parent -eq $cursor -or [string]::IsNullOrEmpty($parent)) { break }
    $cursor = $parent
  }
  return $full
}

function Assert-HermesExactRuntimeRoot {
  param([string]$RuntimeRoot)
  $full = Assert-LiteralRuntimeRoot $RuntimeRoot
  $cursor = $full
  while (-not (Test-Path -LiteralPath $cursor)) {
    $parentInfo = [IO.Directory]::GetParent($cursor)
    if ($null -eq $parentInfo -or [string]::IsNullOrEmpty($parentInfo.FullName) -or $parentInfo.FullName -eq $cursor) { throw 'RuntimeRoot has no existing local ancestor.' }
    $cursor = $parentInfo.FullName
  }
  $canonicalGuard = [HermesRuntime.NativeFileGuard]::OpenObservation($cursor)
  try {
    $canonicalExisting = $canonicalGuard.GetCanonicalPath()
    if ($canonicalExisting.StartsWith('\\?\', [StringComparison]::Ordinal)) { $canonicalExisting = $canonicalExisting.Substring(4) }
    if (-not $cursor.TrimEnd('\').Equals($canonicalExisting.TrimEnd('\'), [StringComparison]::Ordinal)) { throw 'RuntimeRoot has on-disk path case drift.' }
  } finally { $canonicalGuard.Dispose() }
  return $full
}

function Assert-ChildPath {
  param([string]$Root, [string]$Path)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $pathFull = [IO.Path]::GetFullPath($Path)
  if (-not $pathFull.StartsWith("$rootFull\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Resolved path escapes RuntimeRoot.' }
  $relative = $pathFull.Substring($rootFull.Length).TrimStart('\')
  if (Test-UnsafeArchiveMember $relative) { throw 'Resolved child path has an unsafe Windows path component.' }
  $cursor = $rootFull
  if (Test-Path -LiteralPath $cursor) {
    $rootItem = Get-Item -LiteralPath $cursor -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $rootItem.PSIsContainer) { throw 'RuntimeRoot is not a literal directory.' }
  }
  foreach ($segment in ($relative -split '\\')) {
    $cursor = Join-Path $cursor $segment
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Resolved child path traverses or names a reparse point.' }
    }
  }
  return $pathFull
}

function Assert-HermesTestFixtureRoot {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  if (-not $root.StartsWith(($temporaryRoot + '\'), [StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFileName($root.TrimEnd('\')).StartsWith('jarvis-hermes-workflow-fixture-', [StringComparison]::Ordinal)) { throw 'Synthetic operations require an exact ephemeral fixture root.' }
  return $root
}

function Open-HermesSafeIdentity {
  param([string]$Path, [switch]$Directory)
  try { $guard = [HermesRuntime.NativeFileGuard]::Open([IO.Path]::GetFullPath($Path)) } catch { throw "Unable to obtain a safe no-follow filesystem identity for '$Path': $($_.Exception.Message)" }
  $isDirectory = ($guard.Attributes -band [uint32][IO.FileAttributes]::Directory) -ne 0
  $isReparse = ($guard.Attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0
  $unsafeStreams = @($guard.Streams | Where-Object { $_ -cne '::$DATA' })
  if ($isReparse -or $isDirectory -ne [bool]$Directory -or (-not $Directory -and $guard.LinkCount -ne 1) -or $unsafeStreams.Count -ne 0) {
    $guard.Dispose()
    throw 'Filesystem object is a reparse point, hardlink, alternate stream, or has the wrong identity type.'
  }
  return $guard
}

function Open-HermesReadOnlySnapshotIdentity {
  param([string]$Path)
  try { $guard = [HermesRuntime.NativeFileGuard]::OpenReadOnlySnapshot([IO.Path]::GetFullPath($Path)) } catch { throw "Unable to retain a read-only no-follow filesystem identity for '$Path': $($_.Exception.Message)" }
  $isDirectory = ($guard.Attributes -band [uint32][IO.FileAttributes]::Directory) -ne 0
  $isReparse = ($guard.Attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0
  $unsafeStreams = @($guard.Streams | Where-Object { $_ -cne '::$DATA' })
  if ($isReparse -or $isDirectory -or $guard.LinkCount -ne 1 -or $unsafeStreams.Count -ne 0) {
    $guard.Dispose()
    throw 'Read-only snapshot object is a reparse point, hardlink, alternate stream, or has the wrong identity type.'
  }
  return $guard
}

function Open-HermesSafeObservationIdentity {
  param([string]$Path)
  try { $guard = [HermesRuntime.NativeFileGuard]::OpenObservation([IO.Path]::GetFullPath($Path)) } catch {
    $nativeError = 0
    $exception = $_.Exception
    while ($null -ne $exception) { if ($exception -is [ComponentModel.Win32Exception]) { $nativeError = $exception.NativeErrorCode; break }; $exception = $exception.InnerException }
    throw "Unable to observe a safe no-follow filesystem identity for '$Path' (Win32 $nativeError)."
  }
  $isDirectory = ($guard.Attributes -band [uint32][IO.FileAttributes]::Directory) -ne 0
  $isReparse = ($guard.Attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0
  $unsafeStreams = @($guard.Streams | Where-Object { $_ -cne '::$DATA' })
  if ($isReparse -or $isDirectory -or $guard.LinkCount -ne 1 -or $unsafeStreams.Count -ne 0) {
    $guard.Dispose()
    throw 'Observed filesystem object is a reparse point, hardlink, alternate stream, or has the wrong identity type.'
  }
  return $guard
}

function Enter-HermesExtractionLeaseChain {
  param([string]$StableRoot, [string]$Destination)
  $root = Assert-LiteralRuntimeRoot ([IO.Path]::GetFullPath($StableRoot))
  $destinationFull = Assert-ChildPath $root ([IO.Path]::GetFullPath($Destination))
  if (-not (Test-Path -LiteralPath $root -PathType Container) -or -not (Test-Path -LiteralPath $destinationFull -PathType Container)) { throw 'Extraction lease chain must already exist.' }
  $paths = [Collections.Generic.List[string]]::new()
  $paths.Add($root)
  $cursor = $root
  foreach ($segment in $destinationFull.Substring($root.Length).TrimStart('\') -split '\\') {
    if ([string]::IsNullOrEmpty($segment)) { continue }
    $cursor = Join-Path $cursor $segment
    $paths.Add($cursor)
  }
  $leases = [Collections.Generic.List[IDisposable]]::new()
  $leasedPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  try {
    foreach ($path in $paths) {
      $lease = [HermesRuntime.NativeFileGuard]::OpenDirectoryLease($path)
      $isDirectory = ($lease.Attributes -band [uint32][IO.FileAttributes]::Directory) -ne 0
      $isReparse = ($lease.Attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0
      $unsafeStreams = @($lease.Streams | Where-Object { $_ -cne '::$DATA' })
      if (-not $isDirectory -or $isReparse -or $unsafeStreams.Count -ne 0) { $lease.Dispose(); throw 'Extraction lease path is not a safe literal directory.' }
      $leases.Add($lease)
      [void]$leasedPaths.Add($path)
    }
    return [pscustomobject]@{ StableRoot = $root; Destination = $destinationFull; Leases = $leases; Paths = $leasedPaths }
  } catch {
    for ($index = $leases.Count - 1; $index -ge 0; $index--) { $leases[$index].Dispose() }
    throw
  }
}

function Add-HermesExtractionDirectoryLease {
  param([pscustomobject]$Context, [string]$Path)
  $pathFull = Assert-ChildPath ([string]$Context.Destination) ([IO.Path]::GetFullPath($Path))
  if ($Context.Paths.Contains($pathFull)) { return }
  $lease = [HermesRuntime.NativeFileGuard]::OpenDirectoryLease($pathFull)
  $isDirectory = ($lease.Attributes -band [uint32][IO.FileAttributes]::Directory) -ne 0
  $isReparse = ($lease.Attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0
  $unsafeStreams = @($lease.Streams | Where-Object { $_ -cne '::$DATA' })
  if (-not $isDirectory -or $isReparse -or $unsafeStreams.Count -ne 0) { $lease.Dispose(); throw 'Extraction directory is not a safe literal leased directory.' }
  $Context.Leases.Add($lease)
  [void]$Context.Paths.Add($pathFull)
}

function Exit-HermesExtractionLeaseChain {
  param([pscustomobject]$Context)
  if ($null -eq $Context) { return }
  for ($index = $Context.Leases.Count - 1; $index -ge 0; $index--) { $Context.Leases[$index].Dispose() }
}

function Assert-HermesDirectoryLease {
  param([object]$Lease, [string]$Label)
  $isDirectory = ($Lease.Attributes -band [uint32][IO.FileAttributes]::Directory) -ne 0
  $isReparse = ($Lease.Attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0
  $unsafeStreams = @($Lease.Streams | Where-Object { $_ -cne '::$DATA' })
  if (-not $isDirectory -or $isReparse -or $unsafeStreams.Count -ne 0) { throw "$Label is not a safe literal directory." }
}

function Test-HermesOrdinalPathSetEqual {
  param([object[]]$Expected, [object[]]$Actual)
  $expectedSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $actualSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($value in @($Expected)) {
    if ($null -eq $value -or -not $expectedSet.Add([string]$value)) { return $false }
  }
  foreach ($value in @($Actual)) {
    if ($null -eq $value -or -not $actualSet.Add([string]$value)) { return $false }
  }
  if ($expectedSet.Count -ne $actualSet.Count) { return $false }
  foreach ($value in $expectedSet) { if (-not $actualSet.Contains($value)) { return $false } }
  return $true
}

function Assert-HermesExactDirectorySpelling {
  param([pscustomobject]$Context, [string]$Path, [string]$Label)
  $root = Assert-HermesContainmentContext $Context
  $full = Assert-ChildPath $root ([IO.Path]::GetFullPath($Path).TrimEnd('\'))
  if (-not $Context.Leases.ContainsKey($full)) { throw "$Label is not retained by its exact containment lease." }
  $parent = $root
  foreach ($segment in @($full.Substring($root.Length).TrimStart('\') -split '\\' | Where-Object { -not [string]::IsNullOrEmpty($_) })) {
    $matches = @(Get-ChildItem -LiteralPath $parent -Force | Where-Object { $_.Name.Equals($segment, [StringComparison]::OrdinalIgnoreCase) })
    if ($matches.Count -ne 1 -or -not $matches[0].PSIsContainer -or -not $matches[0].Name.Equals($segment, [StringComparison]::Ordinal)) { throw "$Label has on-disk path case drift." }
    $child = Assert-ChildPath $root $matches[0].FullName
    if (-not $Context.Leases.ContainsKey($child)) { throw "$Label is not retained by its complete containment lease chain." }
    $lease = $Context.Leases[$child]
    Assert-HermesDirectoryLease $lease $Label
    $parent = $child
  }
  return $full
}

function New-HermesWriteContainmentContext {
  param([string]$RuntimeRoot, [object]$WorkflowLock)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  if ($null -eq $WorkflowLock -or $WorkflowLock -isnot [IDisposable] -or -not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Write containment requires an acquired workflow lock and existing RuntimeRoot.' }
  return [pscustomobject]@{
    RuntimeRoot = $root
    WorkflowLock = $WorkflowLock
    Leases = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    GitWritableAnchors = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    GitWritableAnchorPaths = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    GitWritablePaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    AnchorLeaf = '.hermes-containment.anchor'
    Active = $true
  }
}

function Assert-HermesContainmentContext {
  param([pscustomobject]$Context)
  if ($null -eq $Context -or -not [bool]$Context.Active -or $null -eq $Context.WorkflowLock -or $null -eq $Context.Leases -or $null -eq $Context.GitWritableAnchors -or $null -eq $Context.GitWritableAnchorPaths -or $null -eq $Context.GitWritablePaths -or [string]::IsNullOrEmpty([string]$Context.AnchorLeaf)) { throw 'Hermes write containment context is absent or inactive.' }
  return Assert-LiteralRuntimeRoot ([string]$Context.RuntimeRoot)
}

function Test-HermesContainedDirectory {
  param([pscustomobject]$Context, [string]$Path)
  $root = Assert-HermesContainmentContext $Context
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($full.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  [void](Assert-ChildPath $root $full)
  return $Context.Leases.ContainsKey($full)
}

function Assert-HermesContainedParent {
  param([pscustomobject]$Context, [string]$Path)
  $root = Assert-HermesContainmentContext $Context
  $full = Assert-ChildPath $root ([IO.Path]::GetFullPath($Path))
  $parent = [IO.Directory]::GetParent($full).FullName.TrimEnd('\')
  if (-not $parent.Equals($root, [StringComparison]::OrdinalIgnoreCase) -and -not $Context.Leases.ContainsKey($parent)) { throw 'Pathname mutation requires a retained lease on its exact destination parent.' }
  return $full
}

function Add-HermesDirectoryLease {
  param([pscustomobject]$Context, [string]$Path, [switch]$Movable)
  $root = Assert-HermesContainmentContext $Context
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($full.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { return $full }
  [void](Assert-ChildPath $root $full)
  if ($Context.Leases.ContainsKey($full)) {
    if ($Movable -and -not [bool]$Context.Leases[$full].MoveCapable) { throw 'An existing directory lease is not move-capable.' }
    return $full
  }
  $parent = [IO.Directory]::GetParent($full).FullName.TrimEnd('\')
  if (-not $parent.Equals($root, [StringComparison]::OrdinalIgnoreCase) -and -not $Context.Leases.ContainsKey($parent)) { [void](Add-HermesDirectoryLease $Context $parent) }
  if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw 'Directory lease target is absent.' }
  $lease = if ($Movable) { [HermesRuntime.NativeFileGuard]::OpenMovableDirectoryLease($full) } else { [HermesRuntime.NativeFileGuard]::OpenDirectoryLease($full) }
  try { Assert-HermesDirectoryLease $lease 'Write containment lease target' } catch { $lease.Dispose(); throw }
  $Context.Leases.Add($full, $lease)
  return $full
}

function New-HermesLeasedDirectory {
  param([pscustomobject]$Context, [string]$Path, [switch]$FreshLeaf, [switch]$MovableLeaf)
  $root = Assert-HermesContainmentContext $Context
  $full = Assert-ChildPath $root ([IO.Path]::GetFullPath($Path))
  if ($FreshLeaf -and (Test-Path -LiteralPath $full)) { throw 'Fresh contained directory already exists.' }
  $relative = $full.Substring($root.Length).TrimStart('\')
  $cursor = $root
  $segments = @($relative -split '\\' | Where-Object { -not [string]::IsNullOrEmpty($_) })
  for ($segmentIndex = 0; $segmentIndex -lt $segments.Count; $segmentIndex++) {
    $segment = $segments[$segmentIndex]
    $cursor = Join-Path $cursor $segment
    $created = $false
    if (-not (Test-Path -LiteralPath $cursor)) {
      [HermesRuntime.NativeFileGuard]::CreateDirectoryNew($cursor)
      $created = $true
    }
    [void](Add-HermesDirectoryLease $Context $cursor -Movable:($MovableLeaf -and $segmentIndex -eq $segments.Count - 1))
    if ($created -and @(Get-ChildItem -LiteralPath $cursor -Force).Count -ne 0) { throw 'Fresh contained directory gained unexpected entries before its lease was acquired.' }
    if ($FreshLeaf -and $segmentIndex -eq $segments.Count - 1 -and @(Get-ChildItem -LiteralPath $cursor -Force).Count -ne 0) { throw 'Fresh contained directory is not empty after atomic creation and lease acquisition.' }
  }
  return $full
}

function New-HermesContainedScratchDirectory {
  param([pscustomobject]$Context, [ValidateSet('git','index','payload')][string]$Purpose)
  $root = Assert-HermesContainmentContext $Context
  $scratch = Join-Path $root ('.verify-{0}-{1}' -f $Purpose, [guid]::NewGuid().ToString('N'))
  [void](New-HermesLeasedDirectory $Context $scratch -FreshLeaf)
  return $scratch
}

function Clear-HermesContainedScratchResidue {
  param([pscustomobject]$Context)
  $root = Assert-HermesContainmentContext $Context
  foreach ($item in @(Get-ChildItem -LiteralPath $root -Force)) {
    if ($item.Name -cnotmatch '^\.verify-(?:git|index|payload)-[a-f0-9]{32}$') { continue }
    if (-not $item.PSIsContainer) { throw 'Contained scratch residue is not a directory.' }
    Remove-HermesContainedTreeNoFollow $Context $item.FullName
  }
}

function Assert-NoHermesContainedScratchResidue {
  param([pscustomobject]$Context)
  $root = Assert-HermesContainmentContext $Context
  foreach ($item in @(Get-ChildItem -LiteralPath $root -Force)) {
    if ($item.Name -cmatch '^\.verify-(?:git|index|payload)-[a-f0-9]{32}$') {
      throw 'VerifyOnly refuses mutation while contained scratch residue exists.'
    }
  }
}

function Add-HermesDirectoryTreeLeases {
  param([pscustomobject]$Context, [string]$Path, [switch]$MovableRoot)
  $root = Assert-HermesContainmentContext $Context
  $tree = Assert-ChildPath $root ([IO.Path]::GetFullPath($Path))
  [void](Add-HermesDirectoryLease $Context $tree -Movable:$MovableRoot)
  $pending = [Collections.Generic.Queue[string]]::new()
  $pending.Enqueue($tree)
  while ($pending.Count -gt 0) {
    $parent = $pending.Dequeue()
    foreach ($item in @(Get-ChildItem -LiteralPath $parent -Force -Directory)) {
      $child = Assert-ChildPath $root $item.FullName
      [void](Add-HermesDirectoryLease $Context $child)
      $pending.Enqueue($child)
    }
  }
  return $tree
}

function Release-HermesDirectoryLeaseSubtree {
  param([pscustomobject]$Context, [string]$Path, [switch]$RetainRootLease)
  $root = Assert-HermesContainmentContext $Context
  $subtree = Assert-ChildPath $root ([IO.Path]::GetFullPath($Path))
  if (@($Context.GitWritablePaths | Where-Object { $_.Equals($subtree, [StringComparison]::OrdinalIgnoreCase) -or $_.StartsWith(($subtree + '\'), [StringComparison]::OrdinalIgnoreCase) }).Count -ne 0) { throw 'Git-writable directory anchors must be transitioned back to strict leases before releasing a subtree.' }
  $keys = @($Context.Leases.Keys | Where-Object { $_.Equals($subtree, [StringComparison]::OrdinalIgnoreCase) -or $_.StartsWith(($subtree + '\'), [StringComparison]::OrdinalIgnoreCase) } | Sort-Object Length -Descending)
  $retained = $null
  foreach ($key in $keys) {
    if ($RetainRootLease -and $key.Equals($subtree, [StringComparison]::OrdinalIgnoreCase)) { $retained = $Context.Leases[$key]; [void]$Context.Leases.Remove($key); continue }
    $Context.Leases[$key].Dispose(); [void]$Context.Leases.Remove($key)
  }
  return $retained
}

function Enter-HermesGitWritableDirectory {
  param([pscustomobject]$Context, [string]$Path)
  $root = Assert-HermesContainmentContext $Context
  $full = Assert-ChildPath $root ([IO.Path]::GetFullPath($Path))
  [void](Add-HermesDirectoryLease $Context $full)
  if ($Context.GitWritablePaths.Contains($full)) { return $full }
  $strictLease = $Context.Leases[$full]
  $anchorPath = Assert-HermesContainedParent $Context (Join-Path $full ([string]$Context.AnchorLeaf))
  $anchor = $null
  $relaxedLease = $null
  try {
    $anchor = [HermesRuntime.NativeFileGuard]::CreateAnchorFile($anchorPath)
    $relaxedLease = [HermesRuntime.NativeFileGuard]::OpenGitWritableDirectoryLease($full, [bool]$strictLease.MoveCapable)
    Assert-HermesDirectoryLease $relaxedLease 'Git-writable containment lease target'
    if ([string]$relaxedLease.Identity -cne [string]$strictLease.Identity) { throw 'Git-writable containment lease changed directory identity.' }
    $Context.GitWritableAnchors.Add($full, $anchor)
    $Context.GitWritableAnchorPaths.Add($full, $anchorPath)
    [void]$Context.GitWritablePaths.Add($full)
    $Context.Leases[$full] = $relaxedLease
    $strictLease.Dispose()
    $anchor = $null
    $relaxedLease = $null
    return $full
  } catch {
    if ($null -ne $relaxedLease) { $relaxedLease.Dispose() }
    if ($null -ne $anchor) { $anchor.Dispose() }
    throw
  }
}

function Exit-HermesGitWritableDirectory {
  param([pscustomobject]$Context, [string]$Path)
  $root = Assert-HermesContainmentContext $Context
  $full = Assert-ChildPath $root ([IO.Path]::GetFullPath($Path))
  if (-not $Context.GitWritablePaths.Contains($full)) { return $full }
  $relaxedLease = $Context.Leases[$full]
  $strictLease = if ([bool]$relaxedLease.MoveCapable) { [HermesRuntime.NativeFileGuard]::OpenMovableDirectoryLease($full) } else { [HermesRuntime.NativeFileGuard]::OpenDirectoryLease($full) }
  try {
    Assert-HermesDirectoryLease $strictLease 'Strict containment lease transition target'
    if ([string]$strictLease.Identity -cne [string]$relaxedLease.Identity) { throw 'Strict containment transition changed directory identity.' }
  } catch { $strictLease.Dispose(); throw }
  $Context.Leases[$full] = $strictLease
  $relaxedLease.Dispose()
  $anchor = $Context.GitWritableAnchors[$full]
  $anchorPath = [string]$Context.GitWritableAnchorPaths[$full]
  $anchor.Dispose()
  [void]$Context.GitWritableAnchors.Remove($full)
  [void]$Context.GitWritableAnchorPaths.Remove($full)
  [void]$Context.GitWritablePaths.Remove($full)
  if (Test-Path -LiteralPath $anchorPath) { throw 'Git-writable containment anchor remains after strict lease transition.' }
  return $full
}

function Enter-HermesGitWritableDirectoryTree {
  param([pscustomobject]$Context, [string]$Path)
  $root = Assert-HermesContainmentContext $Context
  $tree = Assert-ChildPath $root ([IO.Path]::GetFullPath($Path))
  [void](Add-HermesDirectoryTreeLeases $Context $tree)
  $paths = @($Context.Leases.Keys | Where-Object { $_.Equals($tree, [StringComparison]::OrdinalIgnoreCase) -or $_.StartsWith(($tree + '\'), [StringComparison]::OrdinalIgnoreCase) } | Sort-Object Length -Descending)
  try {
    foreach ($directory in $paths) { [void](Enter-HermesGitWritableDirectory $Context $directory) }
  } catch {
    foreach ($directory in $paths) { if ($Context.GitWritablePaths.Contains($directory)) { try { [void](Exit-HermesGitWritableDirectory $Context $directory) } catch { } } }
    throw
  }
  return $tree
}

function Exit-HermesGitWritableDirectoryTree {
  param([pscustomobject]$Context, [string]$Path)
  $root = Assert-HermesContainmentContext $Context
  $tree = Assert-ChildPath $root ([IO.Path]::GetFullPath($Path))
  $paths = @($Context.GitWritablePaths | Where-Object { $_.Equals($tree, [StringComparison]::OrdinalIgnoreCase) -or $_.StartsWith(($tree + '\'), [StringComparison]::OrdinalIgnoreCase) } | Sort-Object Length -Descending)
  foreach ($directory in $paths) { [void](Exit-HermesGitWritableDirectory $Context $directory) }
  return $tree
}

function Exit-HermesWriteContainment {
  param([pscustomobject]$Context)
  if ($null -eq $Context -or -not [bool]$Context.Active) { return }
  $failure = $null
  try {
    foreach ($key in @($Context.GitWritablePaths | Sort-Object Length -Descending)) {
      try { [void](Exit-HermesGitWritableDirectory $Context $key) } catch { if ($null -eq $failure) { $failure = $_ } }
    }
  } finally {
    foreach ($key in @($Context.GitWritableAnchors.Keys)) {
      $anchor = $Context.GitWritableAnchors[$key]
      $anchor.Dispose()
      [void]$Context.GitWritableAnchors.Remove($key)
      [void]$Context.GitWritableAnchorPaths.Remove($key)
      [void]$Context.GitWritablePaths.Remove($key)
    }
    foreach ($key in @($Context.Leases.Keys | Sort-Object Length -Descending)) { $Context.Leases[$key].Dispose(); [void]$Context.Leases.Remove($key) }
    $Context.Active = $false
  }
  if ($null -ne $failure) { throw $failure }
}

function Enter-HermesContainmentScope {
  param([string]$RuntimeRoot, [pscustomobject]$LeaseContext = $null)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  if ($null -ne $LeaseContext) {
    if ((Assert-HermesContainmentContext $LeaseContext) -cne $root) { throw 'Write-containment context is bound to a different RuntimeRoot.' }
    return [pscustomobject]@{ Context = $LeaseContext; WorkflowLock = $null; OwnsContext = $false }
  }
  $lock = Enter-HermesWorkflowLock $root
  try { $context = New-HermesWriteContainmentContext $root $lock } catch { $lock.Dispose(); throw }
  return [pscustomobject]@{ Context = $context; WorkflowLock = $lock; OwnsContext = $true }
}

function Exit-HermesContainmentScope {
  param([pscustomobject]$Scope)
  if ($null -eq $Scope -or -not [bool]$Scope.OwnsContext) { return }
  try { Exit-HermesWriteContainment $Scope.Context } finally { $Scope.WorkflowLock.Dispose() }
}

function Open-HermesContainedFileCreateNew {
  param([pscustomobject]$Context, [string]$Path)
  $full = Assert-HermesContainedParent $Context $Path
  return [IO.FileStream]::new($full, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 131072, [IO.FileOptions]::WriteThrough)
}

function Write-HermesContainedBytesCreateNew {
  param([pscustomobject]$Context, [string]$Path, [byte[]]$Bytes)
  $stream = Open-HermesContainedFileCreateNew $Context $Path
  try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  $guard = Open-HermesSafeIdentity ([IO.Path]::GetFullPath($Path))
  try { if ([uint64]$guard.Size -ne [uint64]$Bytes.LongLength) { throw 'Contained file byte count drift.' } } finally { $guard.Dispose() }
}

function Write-HermesContainedTextCreateNew {
  param([pscustomobject]$Context, [string]$Path, [string]$Text)
  Write-HermesContainedBytesCreateNew $Context $Path ([Text.UTF8Encoding]::new($false).GetBytes($Text))
}

function Copy-HermesContainedFileCreateNew {
  param([pscustomobject]$Context, [string]$Source, [string]$Destination)
  $sourceFull = Assert-HermesContainedParent $Context $Source
  $destinationFull = Assert-HermesContainedParent $Context $Destination
  $sourceGuard = Open-HermesSafeIdentity $sourceFull
  $input = $null
  $output = $null
  try {
    $sourceSize = [uint64]$sourceGuard.Size
    $sourceHash = Get-Sha256Hex $sourceFull
    $input = [IO.File]::Open($sourceFull, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ([uint64]$input.Length -ne $sourceSize) { throw 'Contained copy source identity drift.' }
    $output = Open-HermesContainedFileCreateNew $Context $destinationFull
    $input.CopyTo($output, 131072); $output.Flush($true)
  } finally {
    if ($null -ne $output) { $output.Dispose() }
    if ($null -ne $input) { $input.Dispose() }
    $sourceGuard.Dispose()
  }
  $destinationGuard = Open-HermesSafeIdentity $destinationFull
  try { if ([uint64]$destinationGuard.Size -ne $sourceSize) { throw 'Contained copy destination byte count drift.' } } finally { $destinationGuard.Dispose() }
  if ((Get-Sha256Hex $destinationFull) -cne $sourceHash) { throw 'Contained copy destination content drift.' }
}

function Move-HermesContainedFileNoReplace {
  param([pscustomobject]$Context, [string]$Source, [string]$Destination)
  $sourceFull = Assert-HermesContainedParent $Context $Source
  $destinationFull = Assert-HermesContainedParent $Context $Destination
  if (Test-Path -LiteralPath $destinationFull) { throw 'Contained file destination already exists.' }
  $sourceGuard = Open-HermesSafeIdentity $sourceFull
  try { $identity = [string]$sourceGuard.Identity; $size = [uint64]$sourceGuard.Size; $hash = Get-Sha256Hex $sourceFull } finally { $sourceGuard.Dispose() }
  $parents = @(@([IO.Directory]::GetParent($sourceFull).FullName.TrimEnd('\'), [IO.Directory]::GetParent($destinationFull).FullName.TrimEnd('\')) | Where-Object { -not $_.Equals([string]$Context.RuntimeRoot, [StringComparison]::OrdinalIgnoreCase) } | Sort-Object -Unique)
  $enteredParents = [Collections.Generic.List[string]]::new()
  try {
    foreach ($parent in $parents) { [void](Enter-HermesGitWritableDirectory $Context $parent); $enteredParents.Add($parent) }
    [HermesRuntime.NativeFileGuard]::DurableMoveNoReplace($sourceFull, $destinationFull)
    for ($index = $enteredParents.Count - 1; $index -ge 0; $index--) { [void](Exit-HermesGitWritableDirectory $Context $enteredParents[$index]) }
    $enteredParents.Clear()
    $destinationGuard = Open-HermesSafeIdentity $destinationFull
    try { if ([string]$destinationGuard.Identity -cne $identity -or [uint64]$destinationGuard.Size -ne $size) { throw 'Contained file move changed filesystem identity.' } } finally { $destinationGuard.Dispose() }
    if ((Get-Sha256Hex $destinationFull) -cne $hash) { throw 'Contained file move changed content.' }
  } finally {
    for ($index = $enteredParents.Count - 1; $index -ge 0; $index--) { [void](Exit-HermesGitWritableDirectory $Context $enteredParents[$index]) }
  }
}

function Move-HermesLeasedDirectoryNoReplace {
  param([pscustomobject]$Context, [string]$Source, [string]$Destination, [scriptblock]$MutationBoundary = $null, [scriptblock]$ValidationBoundary = $null)
  $root = Assert-HermesContainmentContext $Context
  $sourceFull = Assert-HermesContainedParent $Context $Source
  $destinationFull = Assert-HermesContainedParent $Context $Destination
  if ($destinationFull.StartsWith(($sourceFull + '\'), [StringComparison]::OrdinalIgnoreCase) -or $sourceFull.StartsWith(($destinationFull + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Contained directory move paths overlap.' }
  if (Test-Path -LiteralPath $destinationFull) { throw 'Contained directory destination already exists.' }
  [void](Add-HermesDirectoryTreeLeases $Context $sourceFull -MovableRoot)
  $identity = [string]$Context.Leases[$sourceFull].Identity
  $digest = ''
  $parents = @(@([IO.Directory]::GetParent($sourceFull).FullName.TrimEnd('\'), [IO.Directory]::GetParent($destinationFull).FullName.TrimEnd('\')) | Where-Object { -not $_.Equals([string]$Context.RuntimeRoot, [StringComparison]::OrdinalIgnoreCase) } | Sort-Object -Unique)
  $enteredParents = [Collections.Generic.List[string]]::new()
  $sourceMoveLease = $null
  $sourceSnapshot = $null
  $destinationSnapshot = $null
  $moved = $false
  try {
    $sourceSnapshot = Enter-HermesReadOnlyTreeSnapshot $root $sourceFull 'Contained directory move source' $Context
    $digest = Get-HermesDirectoryDigest $root $sourceFull $Context
    Assert-HermesReadOnlyTreeSnapshot $sourceSnapshot
    Exit-HermesReadOnlyTreeSnapshot $sourceSnapshot
    $sourceSnapshot = $null
    foreach ($parent in $parents) { [void](Enter-HermesGitWritableDirectory $Context $parent); $enteredParents.Add($parent) }
    $sourceMoveLease = Release-HermesDirectoryLeaseSubtree $Context $sourceFull -RetainRootLease
    if ($null -eq $sourceMoveLease -or [string]$sourceMoveLease.Identity -cne $identity -or -not [bool]$sourceMoveLease.MoveCapable) { throw 'Contained directory move lost its exact move-capable source lease.' }
    if ($null -ne $MutationBoundary) { & $MutationBoundary }
    $sourceMoveLease.MoveToNoReplace($destinationFull)
    $moved = $true
    $Context.Leases.Add($destinationFull, $sourceMoveLease)
    $sourceMoveLease = $null
    for ($index = $enteredParents.Count - 1; $index -ge 0; $index--) { [void](Exit-HermesGitWritableDirectory $Context $enteredParents[$index]) }
    $enteredParents.Clear()
    if ([string]$Context.Leases[$destinationFull].Identity -cne $identity) { throw 'Contained directory move changed filesystem identity.' }
    [void](Add-HermesDirectoryTreeLeases $Context $destinationFull)
    $destinationSnapshot = Enter-HermesReadOnlyTreeSnapshot $root $destinationFull 'Contained directory move destination' $Context
    Assert-HermesSafeTree $root $destinationFull 'Contained moved directory' $Context
    if ((Get-HermesDirectoryDigest $root $destinationFull $Context $ValidationBoundary) -cne $digest) { throw 'Contained directory move changed its validated tree digest.' }
    Assert-HermesReadOnlyTreeSnapshot $destinationSnapshot
  } catch {
    $original = $_
    if ($null -ne $destinationSnapshot) { Exit-HermesReadOnlyTreeSnapshot $destinationSnapshot; $destinationSnapshot = $null }
    if ($null -ne $sourceSnapshot) { Exit-HermesReadOnlyTreeSnapshot $sourceSnapshot; $sourceSnapshot = $null }
    if (-not $moved -and $null -ne $sourceMoveLease) { try { $Context.Leases.Add($sourceFull, $sourceMoveLease); $sourceMoveLease = $null } catch { } }
    if (-not $moved -and (Test-Path -LiteralPath $sourceFull -PathType Container)) { try { [void](Add-HermesDirectoryTreeLeases $Context $sourceFull) } catch { } }
    elseif ($moved) {
      $rollbackLease = $null
      $rollbackMoved = $false
      $rollbackFailure = $null
      try {
        for ($index = $enteredParents.Count - 1; $index -ge 0; $index--) { [void](Exit-HermesGitWritableDirectory $Context $enteredParents[$index]) }
        $enteredParents.Clear()
        if ($null -ne $sourceMoveLease) { $rollbackLease = $sourceMoveLease; $sourceMoveLease = $null }
        else { $rollbackLease = Release-HermesDirectoryLeaseSubtree $Context $destinationFull -RetainRootLease }
        if ($null -eq $rollbackLease -or [string]$rollbackLease.Identity -cne $identity -or -not [bool]$rollbackLease.MoveCapable) { throw 'Contained directory rollback lost its exact move-capable destination lease.' }
        foreach ($parent in $parents) { [void](Enter-HermesGitWritableDirectory $Context $parent); $enteredParents.Add($parent) }
        $rollbackLease.MoveToNoReplace($sourceFull)
        $rollbackMoved = $true
        $Context.Leases.Add($sourceFull, $rollbackLease)
        $rollbackLease = $null
        for ($index = $enteredParents.Count - 1; $index -ge 0; $index--) { [void](Exit-HermesGitWritableDirectory $Context $enteredParents[$index]) }
        $enteredParents.Clear()
        [void](Add-HermesDirectoryTreeLeases $Context $sourceFull -MovableRoot)
        $moved = $false
      } catch {
        $rollbackFailure = $_
        if ($null -ne $rollbackLease) {
          $protectedPath = if ($rollbackMoved) { $sourceFull } else { $destinationFull }
          if (-not $Context.Leases.ContainsKey($protectedPath)) { try { $Context.Leases.Add($protectedPath, $rollbackLease); $rollbackLease = $null } catch { } }
        }
      } finally {
        if ($null -ne $rollbackLease) { $rollbackLease.Dispose() }
      }
      if ($null -ne $rollbackFailure) { throw "Contained directory post-move validation failed and exact rollback failed: $($rollbackFailure.Exception.Message)" }
    }
    throw $original
  } finally {
    if ($null -ne $destinationSnapshot) { Exit-HermesReadOnlyTreeSnapshot $destinationSnapshot }
    if ($null -ne $sourceSnapshot) { Exit-HermesReadOnlyTreeSnapshot $sourceSnapshot }
    if ($null -ne $sourceMoveLease) { $sourceMoveLease.Dispose() }
    for ($index = $enteredParents.Count - 1; $index -ge 0; $index--) { [void](Exit-HermesGitWritableDirectory $Context $enteredParents[$index]) }
  }
}

function Remove-HermesContainedFileNoFollow {
  param([pscustomobject]$Context, [string]$Path)
  $full = Assert-HermesContainedParent $Context $Path
  if (-not (Test-Path -LiteralPath $full)) { return }
  $guard = [HermesRuntime.NativeFileGuard]::OpenDeleteGuard($full)
  try {
    $isDirectory = ($guard.Attributes -band [uint32][IO.FileAttributes]::Directory) -ne 0
    $isReparse = ($guard.Attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0
    $unsafeStreams = @($guard.Streams | Where-Object { $_ -cne '::$DATA' })
    if ($isDirectory -or $isReparse -or $guard.LinkCount -ne 1 -or $unsafeStreams.Count -ne 0) { throw 'Contained cleanup file is not a safe regular object.' }
    $guard.DeleteByHandle()
  } finally { $guard.Dispose() }
  if (Test-Path -LiteralPath $full) { throw 'Contained cleanup file remains after no-follow deletion.' }
}

function Remove-HermesContainedTreeNoFollow {
  param([pscustomobject]$Context, [string]$Path)
  $root = Assert-HermesContainmentContext $Context
  $tree = Assert-ChildPath $root ([IO.Path]::GetFullPath($Path))
  if (-not (Test-Path -LiteralPath $tree)) { return }
  [void](Add-HermesDirectoryTreeLeases $Context $tree)
  $directories = @($Context.Leases.Keys | Where-Object { $_.Equals($tree, [StringComparison]::OrdinalIgnoreCase) -or $_.StartsWith(($tree + '\'), [StringComparison]::OrdinalIgnoreCase) } | Sort-Object Length -Descending)
  foreach ($directory in $directories) {
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
      if ($item.PSIsContainer) {
        if (-not $Context.Leases.ContainsKey($item.FullName)) { throw 'Contained cleanup found an unexpected or reparse directory.' }
        continue
      }
      Remove-HermesContainedFileNoFollow $Context $item.FullName
    }
    if (@(Get-ChildItem -LiteralPath $directory -Force).Count -ne 0) { throw 'Contained cleanup directory gained unexpected residue.' }
    $identity = [string]$Context.Leases[$directory].Identity
    $Context.Leases[$directory].Dispose(); [void]$Context.Leases.Remove($directory)
    $deleteGuard = [HermesRuntime.NativeFileGuard]::OpenDeleteGuard($directory)
    try {
      Assert-HermesDirectoryLease $deleteGuard 'Contained cleanup directory'
      if ([string]$deleteGuard.Identity -cne $identity) { throw 'Contained cleanup directory identity changed before deletion.' }
      $deleteGuard.DeleteByHandle()
    } finally { $deleteGuard.Dispose() }
    if (Test-Path -LiteralPath $directory) { throw 'Contained cleanup directory remains after no-follow deletion.' }
  }
}

function Assert-HermesSafeTree {
  param([string]$RuntimeRoot, [string]$Directory, [string]$Label, [pscustomobject]$LeaseContext = $null)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $directoryFull = [IO.Path]::GetFullPath($Directory)
  $tree = if ($directoryFull.Equals($root, [StringComparison]::Ordinal)) { $root } else { Assert-ChildPath $root $directoryFull }
  if (-not (Test-Path -LiteralPath $tree -PathType Container)) { throw "$Label is absent." }
  if ($null -ne $LeaseContext -and $LeaseContext.Leases.ContainsKey($tree)) { Assert-HermesDirectoryLease $LeaseContext.Leases[$tree] $Label }
  else { $rootGuard = Open-HermesSafeIdentity $tree -Directory; try { $null = $rootGuard.Identity } finally { $rootGuard.Dispose() } }
  foreach ($item in @(Get-ChildItem -LiteralPath $tree -Force -Recurse)) {
    if ($item.PSIsContainer -and $null -ne $LeaseContext -and $LeaseContext.Leases.ContainsKey($item.FullName)) { Assert-HermesDirectoryLease $LeaseContext.Leases[$item.FullName] $Label; continue }
    $guard = Open-HermesSafeIdentity $item.FullName -Directory:$item.PSIsContainer
    try { $null = $guard.Identity } finally { $guard.Dispose() }
  }
}

function Enter-HermesReadOnlyTreeSnapshot {
  param([string]$RuntimeRoot, [string]$Directory, [string]$Label, [pscustomobject]$LeaseContext = $null)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $directoryFull = [IO.Path]::GetFullPath($Directory)
  $tree = if ($directoryFull.Equals($root, [StringComparison]::Ordinal)) { $root } else { Assert-ChildPath $root $directoryFull }
  if (-not (Test-Path -LiteralPath $tree -PathType Container)) { throw "$Label is absent." }
  $guards = [Collections.Generic.List[IDisposable]]::new()
  $records = [Collections.Generic.SortedDictionary[string,object]]::new([StringComparer]::Ordinal)
  try {
    if ($null -ne $LeaseContext -and $LeaseContext.Leases.ContainsKey($tree)) {
      $rootGuard = $LeaseContext.Leases[$tree]
      Assert-HermesDirectoryLease $rootGuard $Label
    } else { $rootGuard = Open-HermesSafeIdentity $tree -Directory; $guards.Add($rootGuard) }
    $records.Add('.', [pscustomobject]@{ Directory = $true; Identity = [string]$rootGuard.Identity; Size = [uint64]0 })
    foreach ($item in @(Get-ChildItem -LiteralPath $tree -Force -Recurse)) {
      $relative = $item.FullName.Substring($tree.Length).TrimStart('\').Replace('\','/')
      if ($item.PSIsContainer -and $null -ne $LeaseContext -and $LeaseContext.Leases.ContainsKey($item.FullName)) {
        $guard = $LeaseContext.Leases[$item.FullName]
        Assert-HermesDirectoryLease $guard $Label
      } else {
        $guard = if ($item.PSIsContainer) { Open-HermesSafeIdentity $item.FullName -Directory } else { Open-HermesReadOnlySnapshotIdentity $item.FullName }
        $guards.Add($guard)
      }
      $records.Add($relative, [pscustomobject]@{ Directory = [bool]$item.PSIsContainer; Identity = [string]$guard.Identity; Size = [uint64]$guard.Size })
    }
    return [pscustomobject]@{ RuntimeRoot = $root; Tree = $tree; Label = $Label; Guards = $guards; Records = $records; LeaseContext = $LeaseContext }
  } catch {
    for ($index = $guards.Count - 1; $index -ge 0; $index--) { $guards[$index].Dispose() }
    throw
  }
}

function Assert-HermesReadOnlyTreeSnapshot {
  param([pscustomobject]$Snapshot)
  if ($null -eq $Snapshot -or $Snapshot.Records -isnot [Collections.Generic.SortedDictionary[string,object]] -or $Snapshot.Guards -isnot [Collections.Generic.List[IDisposable]]) { throw 'Read-only tree snapshot is invalid.' }
  $root = Assert-LiteralRuntimeRoot ([string]$Snapshot.RuntimeRoot)
  $tree = if ([string]$Snapshot.Tree -ceq $root) { $root } else { Assert-ChildPath $root ([string]$Snapshot.Tree) }
  $current = [Collections.Generic.SortedDictionary[string,object]]::new([StringComparer]::Ordinal)
  $items = @([pscustomobject]@{ FullName = $tree; PSIsContainer = $true; Relative = '.' }) + @(Get-ChildItem -LiteralPath $tree -Force -Recurse | ForEach-Object { [pscustomobject]@{ FullName = $_.FullName; PSIsContainer = $_.PSIsContainer; Relative = $_.FullName.Substring($tree.Length).TrimStart('\').Replace('\','/') } })
  foreach ($item in $items) {
    $ownedGuard = $false
    if ($item.PSIsContainer -and $null -ne $Snapshot.LeaseContext -and $Snapshot.LeaseContext.Leases.ContainsKey($item.FullName)) { $guard = $Snapshot.LeaseContext.Leases[$item.FullName]; Assert-HermesDirectoryLease $guard ([string]$Snapshot.Label) }
    else { $guard = Open-HermesSafeIdentity $item.FullName -Directory:$item.PSIsContainer; $ownedGuard = $true }
    try { $current.Add([string]$item.Relative, [pscustomobject]@{ Directory = [bool]$item.PSIsContainer; Identity = [string]$guard.Identity; Size = [uint64]$guard.Size }) }
    finally { if ($ownedGuard) { $guard.Dispose() } }
  }
  if ($current.Count -ne $Snapshot.Records.Count) { throw "$($Snapshot.Label) changed during its read-only verification window." }
  foreach ($entry in $Snapshot.Records.GetEnumerator()) {
    if (-not $current.ContainsKey($entry.Key)) { throw "$($Snapshot.Label) changed during its read-only verification window." }
    $actual = $current[$entry.Key]
    if ($actual.Directory -ne $entry.Value.Directory -or [string]$actual.Identity -cne [string]$entry.Value.Identity -or (-not $actual.Directory -and [uint64]$actual.Size -ne [uint64]$entry.Value.Size)) { throw "$($Snapshot.Label) changed during its read-only verification window." }
  }
}

function Exit-HermesReadOnlyTreeSnapshot {
  param([pscustomobject]$Snapshot)
  if ($null -eq $Snapshot -or $Snapshot.Guards -isnot [Collections.Generic.List[IDisposable]]) { throw 'Read-only tree snapshot is invalid.' }
  for ($index = $Snapshot.Guards.Count - 1; $index -ge 0; $index--) { $Snapshot.Guards[$index].Dispose() }
  $Snapshot.Guards.Clear()
}

function Get-Sha256Hex {
  param([string]$Path)
  $guard = Open-HermesSafeIdentity $Path
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([Convert]::ToHexString($sha.ComputeHash($stream))).ToLowerInvariant() } finally { $sha.Dispose(); $stream.Dispose() }
  } finally { $guard.Dispose() }
}

function Assert-ExactHash {
  param([string]$Path, [string]$Expected, [string]$Label)
  if ((Get-Sha256Hex $Path) -ne $Expected) { throw "$Label hash mismatch." }
}

function Get-Manifest {
  param([string]$Path, [string]$ExpectedSha256 = '', [string]$Label = 'Manifest')
  $guard = Open-HermesSafeIdentity $Path
  try {
    $bytes = [IO.File]::ReadAllBytes($Path)
    if (-not [string]::IsNullOrEmpty($ExpectedSha256)) {
      if ($ExpectedSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Manifest expected hash is invalid.' }
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $actualSha256 = ([Convert]::ToHexString($sha.ComputeHash($bytes))).ToLowerInvariant() } finally { $sha.Dispose() }
      if ($actualSha256 -cne $ExpectedSha256) { throw "$Label hash mismatch." }
    }
  } finally { $guard.Dispose() }
  if ($bytes.Length -lt 2 -or ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf)) { throw 'Manifest must be canonical UTF-8 JSON.' }
  try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) } catch { throw 'Manifest must be canonical UTF-8 JSON.' }
  if ($text.Contains("`r") -or -not $text.EndsWith("`n", [StringComparison]::Ordinal) -or $text.EndsWith("`n`n", [StringComparison]::Ordinal)) { throw 'Manifest must use exactly one canonical LF terminator.' }
  try { $manifest = $text | ConvertFrom-Json -AsHashtable -Depth 32 } catch { throw 'Manifest JSON is malformed.' }
  if ($manifest -isnot [hashtable] -or (($manifest | ConvertTo-Json -Compress -Depth 32) + "`n") -cne $text) { throw 'Manifest JSON is noncanonical or contains duplicate keys.' }
  return $manifest
}

function Assert-HermesSourceLock {
  param([hashtable]$Lock)
  if ($null -eq $Lock -or $Lock.schemaVersion -ne '1' -or $Lock.remote -ne 'https://github.com/NousResearch/hermes-agent.git' -or $Lock.tag -ne 'v2026.8.27' -or $Lock.tagObject -ne 'fcebd62163497e77e5de00d26d2ed86cb4ef8761' -or $Lock.sourceCommit -ne '5fc308a70719a83cccdbba4c0e39c23f5a8239d5' -or $Lock.sourceTree -ne '222ec43b5237deb643277bc2f64fa4b873dd7f28' -or $Lock.acquisitionMethod -ne 'git-detached' -or $Lock.submodules.Count -ne 0) { throw 'Hermes source lock is not the reviewed canonical lock.' }
  foreach ($name in @('LICENSE','pyproject.toml','uv.lock')) { if ($Lock.rawFileSha256[$name] -notmatch '^[a-f0-9]{64}$') { throw 'Hermes source lock raw-file hashes are invalid.' } }
}

function Assert-HermesArtifactLock {
  param([hashtable]$Lock)
  $expected = @{ cpython = 'cpython-3.11.16+20260825-x86_64-pc-windows-msvc-install_only_stripped.tar.gz'; uv = 'uv-x86_64-pc-windows-msvc.zip'; winsw = 'WinSW-x64.exe' }
  if ($null -eq $Lock -or $Lock.schemaVersion -ne '1') { throw 'Runtime artifact lock is not canonical.' }
  foreach ($name in $expected.Keys) { $artifact = $Lock[$name]; if ($null -eq $artifact -or $artifact.fileName -ne $expected[$name] -or $artifact.url -notmatch '^https://github\.com/' -or $artifact.size -lt 1 -or $artifact.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Runtime artifact lock is not canonical.' } }
  if ($Lock.pythonBuildStandaloneLicenses.url -ne 'https://raw.githubusercontent.com/astral-sh/python-build-standalone/20260825/python-licenses.rst' -or $Lock.pythonBuildStandaloneLicenses.size -lt 1 -or $Lock.pythonBuildStandaloneLicenses.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Runtime artifact lock is not canonical.' }
}

function Get-HermesTrustedGitExecutable {
  $trusted = 'C:\Program Files\Git\cmd\git.exe'
  $full = [IO.Path]::GetFullPath($trusted)
  if (-not [IO.Path]::IsPathFullyQualified($trusted) -or -not $trusted.Equals($full, [StringComparison]::Ordinal) -or [IO.Path]::GetExtension($trusted) -cne '.exe') { throw 'Trusted Git host path is not the reviewed exact absolute executable.' }
  $cursor = $full
  $leaf = $true
  while ($true) {
    if (-not (Test-Path -LiteralPath $cursor)) { throw 'Trusted Git host is unavailable.' }
    $item = Get-Item -LiteralPath $cursor -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($leaf -and $item.PSIsContainer) -or (-not $leaf -and -not $item.PSIsContainer)) { throw 'Trusted Git host traverses or names an unsafe filesystem object.' }
    $parentInfo = [IO.Directory]::GetParent($cursor)
    if ($null -eq $parentInfo) { break }
    $cursor = $parentInfo.FullName
    $leaf = $false
  }
  $guard = [HermesRuntime.NativeFileGuard]::Open($full)
  try {
    $isDirectory = ($guard.Attributes -band [uint32][IO.FileAttributes]::Directory) -ne 0
    $isReparse = ($guard.Attributes -band [uint32][IO.FileAttributes]::ReparsePoint) -ne 0
    $unsafeStreams = @($guard.Streams | Where-Object { $_ -cne '::$DATA' })
    if ($isDirectory -or $isReparse -or $unsafeStreams.Count -ne 0) { throw 'Trusted Git host is not a safe literal executable.' }
  } finally {
    $guard.Dispose()
  }
  return $full
}

function Invoke-HermesGitProcess {
  param([string]$Git, [string[]]$Arguments, [switch]$BinaryOutput, [string]$IndexFile = '', [pscustomobject]$LeaseContext = $null, [scriptblock]$Boundary = $null)
  $root = Assert-HermesContainmentContext $LeaseContext
  if (-not [IO.Path]::IsPathFullyQualified($Git) -or -not (Test-Path -LiteralPath $Git -PathType Leaf) -or ([IO.Path]::GetExtension($Git) -ine '.exe') -or ((Get-Item -LiteralPath $Git -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Git executable must be an absolute non-reparse application.' }
  $indexFull = ''
  if (-not [string]::IsNullOrEmpty($IndexFile)) {
    $indexFull = Assert-ChildPath $root ([IO.Path]::GetFullPath($IndexFile))
    $indexRoot = [IO.Directory]::GetParent($indexFull).FullName.TrimEnd('\')
    if ([IO.Path]::GetFileName($indexFull) -cne 'index' -or [IO.Path]::GetFileName($indexRoot) -cnotmatch '^\.verify-index-[a-f0-9]{32}$') { throw 'Closed Git index path is not an exact contained index.' }
    if (-not $LeaseContext.Leases.ContainsKey($indexRoot) -or -not $LeaseContext.GitWritablePaths.Contains($indexRoot) -or -not $LeaseContext.GitWritableAnchors.ContainsKey($indexRoot)) { throw 'Closed Git index root is not retained by its writable containment window.' }
  }
  $workspace = New-HermesContainedScratchDirectory $LeaseContext 'git'
  $home = Join-Path $workspace 'home'; [void](New-HermesLeasedDirectory $LeaseContext $home -FreshLeaf)
  $templates = Join-Path $workspace 'templates'; [void](New-HermesLeasedDirectory $LeaseContext $templates -FreshLeaf)
  $temporary = Join-Path $workspace 'tmp'; [void](New-HermesLeasedDirectory $LeaseContext $temporary -FreshLeaf)
  $gitFailure = $null
  try {
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    $machineRoot = [Environment]::GetEnvironmentVariable('SystemRoot', [EnvironmentVariableTarget]::Machine)
    if ([string]::IsNullOrEmpty($machineRoot)) { $machineRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows) }
    if ([string]::IsNullOrEmpty($machineRoot) -or -not [IO.Path]::IsPathFullyQualified($machineRoot)) { throw 'Closed Git SystemRoot is unavailable.' }
    $environment['SystemRoot'] = $machineRoot
    $environment['WINDIR'] = $machineRoot
    $environment['TEMP'] = $temporary
    $environment['TMP'] = $temporary
    $environment['HOME'] = $home
    $environment['USERPROFILE'] = $home
    $environment['XDG_CONFIG_HOME'] = $home
    $environment['GIT_CONFIG_NOSYSTEM'] = '1'
    $environment['GIT_CONFIG_GLOBAL'] = 'NUL'
    $environment['GIT_CONFIG_SYSTEM'] = 'NUL'
    $environment['GIT_CONFIG_COUNT'] = '0'
    $environment['GIT_ATTR_NOSYSTEM'] = '1'
    $environment['GIT_TERMINAL_PROMPT'] = '0'
    $environment['GIT_OPTIONAL_LOCKS'] = '0'
    $environment['GIT_PROTOCOL_FROM_USER'] = '0'
    $environment['GIT_ALLOW_PROTOCOL'] = 'https'
    $environment['GIT_ASKPASS'] = 'NUL'
    $environment['SSH_ASKPASS'] = 'NUL'
    $environment['SSH_ASKPASS_REQUIRE'] = 'never'
    $environment['GCM_INTERACTIVE'] = 'never'
    $environment['GIT_TEMPLATE_DIR'] = $templates
    if (-not [string]::IsNullOrEmpty($indexFull)) { $environment['GIT_INDEX_FILE'] = $indexFull }
    $closedArguments = [string[]]@((Get-HermesGitIsolationOptions) + $Arguments)
    if ($null -ne $Boundary) {
      & $Boundary 'before-git-workspace-process-start'
      if (-not [string]::IsNullOrEmpty($indexFull)) { & $Boundary 'before-git-index-process-start' }
    }
    $result = [HermesRuntime.NativeProcessRunner]::Run($Git, $closedArguments, $environment, $workspace)
    $output = [byte[]]$result.Stdout
    $error = [string]$result.Stderr
    $exitCode = [int]$result.ExitCode
    if ($exitCode -ne 0) { throw "git command failed: $error" }
    if ($BinaryOutput) { return ,$output }
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($output); return @($text -split "`r?`n" | Where-Object { $_.Length -gt 0 } | ForEach-Object { $_.Trim() })
  } catch {
    $gitFailure = $_
    throw
  } finally {
    $workspaceCleanupFailure = $null
    try {
      if (Test-Path -LiteralPath $workspace) { Remove-HermesContainedTreeNoFollow $LeaseContext $workspace; if (Test-Path -LiteralPath $workspace) { throw 'Closed Git workspace cleanup failed.' } }
    } catch {
      $workspaceCleanupFailure = $_
    }
    if ($null -ne $workspaceCleanupFailure) {
      if ($null -ne $gitFailure) {
        $message = "Git operation failed: $($gitFailure.Exception.Message) Closed Git workspace cleanup also failed closed."
        throw [InvalidOperationException]::new($message, $gitFailure.Exception)
      }
      throw [InvalidOperationException]::new('Closed Git workspace cleanup failed closed.', $workspaceCleanupFailure.Exception)
    }
  }
}

function Invoke-GitChecked {
  param([string]$Git, [string[]]$Arguments, [pscustomobject]$LeaseContext = $null, [scriptblock]$Boundary = $null)
  return @(Invoke-HermesGitProcess $Git $Arguments -LeaseContext $LeaseContext -Boundary $Boundary)
}

function Get-HermesGitTreePaths {
  param([string]$Git, [string]$GitDirectory, [string]$Commit, [pscustomobject]$LeaseContext = $null)
  $bytes = [byte[]](Invoke-HermesGitProcess $Git @('--git-dir', $GitDirectory, 'ls-tree', '-r', '-z', $Commit) -BinaryOutput -LeaseContext $LeaseContext)
  $records = [Text.UTF8Encoding]::new($false, $true).GetString($bytes).Split([char]0, [StringSplitOptions]::RemoveEmptyEntries)
  $entries = @(); foreach ($record in $records) { $parts = $record.Split([char]9, 2); if ($parts.Count -ne 2 -or $parts[0] -notmatch '^(?<mode>[0-7]{6}) (?<type>blob|tree|commit) (?<object>[a-f0-9]{40})$') { throw 'Pinned Git tree record is malformed.' }; $entry = [pscustomobject]@{ Mode = $Matches.mode; Type = $Matches.type; Object = $Matches.object; Path = $parts[1] }; if ((Test-UnsafeArchiveMember $entry.Path) -or $entry.Path -eq '.gitmodules' -or $entry.Mode -in @('120000','160000') -or $entry.Type -ne 'blob') { throw 'Pinned Git tree has a forbidden member.' }; $entries += $entry }
  return @($entries)
}

function Get-HermesGitBlobObjectIdFromBytes {
  param([byte[]]$Bytes)
  if ($null -eq $Bytes) { throw 'Git blob bytes are absent.' }
  $prefix = [Text.Encoding]::ASCII.GetBytes("blob $($Bytes.LongLength)`0")
  $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA1)
  try {
    $hash.AppendData($prefix)
    $hash.AppendData($Bytes)
    return ([Convert]::ToHexString($hash.GetHashAndReset())).ToLowerInvariant()
  } finally {
    $hash.Dispose()
  }
}

function Get-HermesGitBlobObjectId {
  param([string]$Path)
  $guard = Open-HermesSafeIdentity $Path
  $stream = $null
  $hash = $null
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ([uint64]$stream.Length -ne [uint64]$guard.Size) { throw 'Source file identity changed while hashing its Git blob.' }
    $prefix = [Text.Encoding]::ASCII.GetBytes("blob $($stream.Length)`0")
    $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA1)
    $hash.AppendData($prefix)
    $buffer = [byte[]]::new(1048576)
    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) { $hash.AppendData($buffer, 0, $read) }
    return ([Convert]::ToHexString($hash.GetHashAndReset())).ToLowerInvariant()
  } finally {
    if ($null -ne $hash) { $hash.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
    $guard.Dispose()
  }
}

function Assert-HermesGitWorkTreeMatchesCommit {
  param([string]$Git, [string]$GitDirectory, [string]$WorkTree, [string]$Commit, [pscustomobject]$LeaseContext = $null, [scriptblock]$Boundary = $null)
  if ($Commit -notmatch '^[a-f0-9]{40}$') { throw 'Pinned source commit is malformed.' }
  $root = Assert-HermesContainmentContext $LeaseContext
  $gitStore = Assert-ChildPath $root ([IO.Path]::GetFullPath($GitDirectory))
  $workTreeFull = Assert-ChildPath $root ([IO.Path]::GetFullPath($WorkTree))
  [void](Add-HermesDirectoryTreeLeases $LeaseContext $gitStore)
  [void](Add-HermesDirectoryTreeLeases $LeaseContext $workTreeFull)
  $indexRoot = New-HermesContainedScratchDirectory $LeaseContext 'index'
  $indexFile = Join-Path $indexRoot 'index'
  $writable = $false
  try {
    [void](Enter-HermesGitWritableDirectory $LeaseContext $indexRoot)
    $writable = $true
    [void](Invoke-HermesGitProcess $Git @('--git-dir', $gitStore, '--work-tree', $workTreeFull, 'read-tree', '--reset', $Commit) -IndexFile $indexFile -LeaseContext $LeaseContext -Boundary $Boundary)
    try {
      [void](Invoke-HermesGitProcess $Git @('--git-dir', $gitStore, '--work-tree', $workTreeFull, 'update-index', '--really-refresh') -IndexFile $indexFile -LeaseContext $LeaseContext)
      [void](Invoke-HermesGitProcess $Git @('--git-dir', $gitStore, '--work-tree', $workTreeFull, 'diff-files', '--quiet', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--') -IndexFile $indexFile -LeaseContext $LeaseContext)
    } catch {
      throw 'Pinned source Git blob mismatch.'
    }
  } finally {
    if ($writable -and $LeaseContext.GitWritablePaths.Contains($indexRoot)) { [void](Exit-HermesGitWritableDirectory $LeaseContext $indexRoot) }
    if (Test-Path -LiteralPath $indexRoot) { Remove-HermesContainedTreeNoFollow $LeaseContext $indexRoot; if (Test-Path -LiteralPath $indexRoot) { throw 'Closed Git index cleanup failed.' } }
  }
}

function Export-HermesGitBlobsNoClobber {
  param([string]$Git, [string]$GitDirectory, [string]$WorkTree, [object[]]$TreeEntries, [pscustomobject]$LeaseContext = $null)
  $root = Assert-HermesContainmentContext $LeaseContext
  $gitStore = Assert-ChildPath $root ([IO.Path]::GetFullPath($GitDirectory))
  $workTreeFull = Assert-ChildPath $root ([IO.Path]::GetFullPath($WorkTree))
  if (-not (Test-Path -LiteralPath $gitStore -PathType Container) -or -not (Test-Path -LiteralPath $workTreeFull -PathType Container)) { throw 'Pinned source export roots are absent.' }
  if (-not $LeaseContext.Leases.ContainsKey($gitStore) -or -not $LeaseContext.GitWritablePaths.Contains($workTreeFull)) { throw 'Pinned source export roots are not held by the reviewed containment state.' }
  if ($null -eq $TreeEntries -or $TreeEntries.Count -lt 1) { throw 'Pinned source export tree is absent.' }
  $ordered = [Collections.Generic.SortedDictionary[string,object]]::new([StringComparer]::Ordinal)
  foreach ($entry in $TreeEntries) {
    if ($null -eq $entry -or [string]$entry.Mode -cnotmatch '^[0-7]{6}$' -or [string]$entry.Type -cne 'blob' -or [string]$entry.Object -cnotmatch '^[a-f0-9]{40}$' -or (Test-UnsafeArchiveMember ([string]$entry.Path)) -or [string]$entry.Path -ceq '.gitmodules' -or [string]$entry.Mode -in @('120000','160000')) { throw 'Pinned source export tree has a forbidden member.' }
    $ordered.Add([string]$entry.Path, $entry)
  }
  foreach ($pair in $ordered.GetEnumerator()) {
    $entry = $pair.Value
    $bytes = [byte[]](Invoke-HermesGitProcess $Git @('--git-dir', $gitStore, 'cat-file', 'blob', [string]$entry.Object) -BinaryOutput -LeaseContext $LeaseContext)
    if ((Get-HermesGitBlobObjectIdFromBytes $bytes) -cne [string]$entry.Object) { throw 'Pinned source blob bytes do not match the reviewed Git object identity.' }
    $destination = Assert-ChildPath $root (Join-Path $workTreeFull ([string]$entry.Path).Replace('/', '\'))
    Write-HermesContainedBytesCreateNew $LeaseContext $destination $bytes
  }
}

function Test-UnsafeArchiveMember {
  param([string]$Member)
  $candidate = if ($null -eq $Member) { '' } else { $Member.TrimEnd([char[]]@([char]'/', [char]'\')) }
  if ([string]::IsNullOrWhiteSpace($candidate) -or $candidate.StartsWith('/') -or $candidate.StartsWith('\\') -or $candidate -match '(^|[\\/])\.\.([\\/]|$)' -or $candidate -match ':') { return $true }
  foreach ($segment in ($candidate -split '[\\/]')) {
    if ([string]::IsNullOrWhiteSpace($segment) -or $segment -match '\p{Cc}' -or $segment -match '[<>"|?*]' -or $segment -match '[. ]$' -or $segment -match '^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM(?:[1-9\u00B9\u00B2\u00B3])|LPT(?:[1-9\u00B9\u00B2\u00B3]))(\..*)?$') { return $true }
  }
  return $false
}

function Get-HermesGitIsolationOptions {
  return @('--no-replace-objects','-c','core.hooksPath=NUL','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','core.attributesFile=NUL','-c','core.excludesFile=NUL','-c','core.autocrlf=false','-c','core.safecrlf=true','-c','filter.lfs.smudge=','-c','filter.lfs.process=','-c','filter.lfs.required=false','-c','credential.helper=')
}

function Get-HermesCanonicalGitConfig {
  param([string]$Remote)
  if ($Remote -cne 'https://github.com/NousResearch/hermes-agent.git') { throw 'Hermes Git remote is not the reviewed canonical remote.' }
  return @(
    '[core]'
    "`trepositoryformatversion = 0"
    "`tfilemode = false"
    "`tbare = false"
    "`tsymlinks = false"
    "`tignorecase = true"
    "`thooksPath = NUL"
    "`tlongpaths = true"
    "`tautocrlf = false"
    "`tsafecrlf = true"
    '[filter "lfs"]'
    "`tsmudge = "
    "`tprocess = "
    "`trequired = false"
    '[credential]'
    "`thelper = "
    '[remote "origin"]'
    "`turl = $Remote"
    "`tfetch = +refs/tags/v2026.8.27:refs/tags/v2026.8.27"
    ''
  ) -join "`n"
}

function Assert-HermesGitConfig {
  param([string]$RuntimeRoot, [string]$GitDirectory, [string]$ExpectedRemote)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $store = Assert-ChildPath $root $GitDirectory
  if (-not (Test-Path -LiteralPath $store -PathType Container)) { throw 'Pinned source Git object store is absent.' }
  $config = Assert-ChildPath $root (Join-Path $store 'config')
  if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { throw 'Pinned source local Git configuration is absent.' }
  $guard = Open-HermesSafeIdentity $config
  try {
    $bytes = [IO.File]::ReadAllBytes($config)
  } finally {
    $guard.Dispose()
  }
  try {
    $actual = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
  } catch {
    throw 'Pinned source local Git configuration drift.'
  }
  if ($actual -cne (Get-HermesCanonicalGitConfig $ExpectedRemote)) { throw 'Pinned source local Git configuration drift.' }
  foreach ($relative in @('commondir', 'gitdir', 'config.worktree', 'info\attributes', 'info\grafts', 'objects\info\alternates', 'objects\info\http-alternates')) {
    if (Test-Path -LiteralPath (Assert-ChildPath $root (Join-Path $store $relative))) { throw 'Pinned source local Git metadata drift.' }
  }
}

function Assert-HermesDetachedHead {
  param([string]$GitDirectory, [string]$SourceCommit)
  if ($SourceCommit -cnotmatch '^[a-f0-9]{40}$') { throw 'Pinned checkout HEAD commit is malformed.' }
  $head = Join-Path ([IO.Path]::GetFullPath($GitDirectory)) 'HEAD'
  if (-not (Test-Path -LiteralPath $head -PathType Leaf)) { throw 'Pinned checkout HEAD is absent.' }
  $guard = Open-HermesSafeIdentity $head
  try { $bytes = [IO.File]::ReadAllBytes($head) } finally { $guard.Dispose() }
  try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) } catch { throw 'Pinned checkout HEAD is not canonical UTF-8.' }
  if ($text -cne "$SourceCommit`n") { throw 'Pinned checkout HEAD is not detached at the locked source commit.' }
}

function Assert-HermesGitTranscript {
  param([hashtable]$Lock, [string]$GitDirectory, [string]$WorkTree, [scriptblock]$InvokeGit, [object[]]$TreeEntries)
  $call = { param([string[]]$Arguments) @(& $InvokeGit $Arguments) }
  Assert-HermesDetachedHead $GitDirectory ([string]$Lock.sourceCommit)
  $tag = "refs/tags/{0}" -f $Lock.tag
  if ((& $call @('--git-dir', $GitDirectory, 'cat-file', '-t', $tag)) -ne 'tag') { throw 'Pinned tag is not annotated.' }
  if ((& $call @('--git-dir', $GitDirectory, 'rev-parse', ("{0}^{{tag}}" -f $tag))) -ne $Lock.tagObject) { throw 'Pinned tag object mismatch.' }
  if ((& $call @('--git-dir', $GitDirectory, 'rev-parse', ("{0}^{{}}" -f $tag))) -ne $Lock.sourceCommit) { throw 'Pinned tag was retargeted.' }
  if ((& $call @('--git-dir', $GitDirectory, 'rev-parse', ("{0}^{{tree}}" -f $Lock.sourceCommit))) -ne $Lock.sourceTree) { throw 'Pinned source tree mismatch.' }
  $remotes = @(& $call @('--git-dir', $GitDirectory, 'remote')); if ($remotes.Count -ne 1 -or $remotes[0] -ne 'origin') { throw 'Unexpected Git remote.' }
  if ($null -eq $TreeEntries -or $TreeEntries.Count -lt 1) { throw 'Pinned source tree records are absent.' }
  foreach ($entry in $TreeEntries) {
    if ($null -eq $entry -or [string]$entry.Mode -notmatch '^[0-7]{6}$' -or [string]$entry.Type -ne 'blob' -or [string]$entry.Object -notmatch '^[a-f0-9]{40}$' -or (Test-UnsafeArchiveMember ([string]$entry.Path)) -or [string]$entry.Path -eq '.gitmodules' -or [string]$entry.Mode -in @('120000','160000')) { throw 'Pinned source tree has a forbidden member.' }
  }
}

function Assert-HermesSourceDirectory {
  param(
    [string]$RuntimeRoot,
    [string]$Candidate,
    [hashtable]$Lock,
    [string]$GitDirectory = '',
    [scriptblock]$AssertFileHash = $null,
    [scriptblock]$InvokeGit = $null,
    [scriptblock]$GetTreeEntries = $null,
    [scriptblock]$AssertWorkTree = $null,
    [pscustomobject]$LeaseContext = $null,
    [scriptblock]$Boundary = $null
  )
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot; $source = Assert-ChildPath $root $Candidate
  if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw 'Pinned Hermes source is absent.' }
  if ($null -ne $LeaseContext) {
    if ((Assert-HermesContainmentContext $LeaseContext) -cne $root) { throw 'Pinned source verifier containment is bound to a different RuntimeRoot.' }
    [void](Add-HermesDirectoryTreeLeases $LeaseContext $source)
    [void](Assert-HermesExactDirectorySpelling $LeaseContext $source 'Pinned source root')
  }
  $sourceSnapshot = Enter-HermesReadOnlyTreeSnapshot $root $source 'Pinned source' $LeaseContext
  $sourceVerified = $false
  try {
  if ((Get-Item -LiteralPath $source -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Pinned Hermes source is a reparse point.' }
  if (Test-Path -LiteralPath (Join-Path $source '.git')) { throw 'Pinned source must be a detached export without a worktree repository.' }
  foreach ($name in @('LICENSE', 'pyproject.toml', 'uv.lock')) {
    $path = Assert-ChildPath $root (Join-Path $source $name)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Pinned source file is absent: $name" }
    if ($null -eq $AssertFileHash) { Assert-ExactHash $path $Lock.rawFileSha256[$name] "Pinned source $name" } else { & $AssertFileHash $path $Lock.rawFileSha256[$name] "Pinned source $name" }
  }
  Assert-HermesSafeTree $root $source 'Pinned source' $LeaseContext
  if (-not [string]::IsNullOrEmpty($GitDirectory)) {
    $store = Assert-ChildPath $root $GitDirectory; if (-not (Test-Path -LiteralPath $store -PathType Container)) { throw 'Pinned source Git object store is absent.' }
    if ($null -ne $LeaseContext) { [void](Add-HermesDirectoryTreeLeases $LeaseContext $store); [void](Assert-HermesExactDirectorySpelling $LeaseContext $store 'Pinned source Git object store') }
    Assert-HermesSafeTree $root $store 'Pinned source Git object store' $LeaseContext
    $git = if ($null -eq $InvokeGit) { Get-HermesTrustedGitExecutable } else { '' }
    if ($null -eq $InvokeGit -and $null -eq $LeaseContext) { throw 'Default pinned source Git verification requires an active write-containment context.' }
    $configGuard = Open-HermesSafeIdentity (Assert-ChildPath $root (Join-Path $store 'config'))
    $headGuard = Open-HermesSafeIdentity (Assert-ChildPath $root (Join-Path $store 'HEAD'))
    $tagGuard = $null
    try {
      if ($Lock.ContainsKey('tag')) {
        $tagPath = Assert-ChildPath $root (Join-Path $store ("refs\tags\{0}" -f $Lock.tag))
        $tagGuard = Open-HermesSafeIdentity $tagPath
        $expectedTagBytes = [Text.UTF8Encoding]::new($false).GetBytes("$($Lock.tagObject)`n")
        $actualTagBytes = [IO.File]::ReadAllBytes($tagPath)
        if ($actualTagBytes.Length -ne $expectedTagBytes.Length -or -not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals([byte[]]$actualTagBytes, [byte[]]$expectedTagBytes)) { throw 'Pinned tag provenance ref drift.' }
      }
      Assert-HermesDetachedHead $store ([string]$Lock.sourceCommit)
      $treeResult = if ($null -eq $InvokeGit) { Invoke-GitChecked $git @('--git-dir', $store, 'rev-parse', ("{0}^{{tree}}" -f $Lock.sourceCommit)) $LeaseContext } else { @(& $InvokeGit @('--git-dir', $store, 'rev-parse', ("{0}^{{tree}}" -f $Lock.sourceCommit))) }
      if ($treeResult -ne $Lock.sourceTree) { throw 'Pinned source Git tree mismatch.' }
      $entries = if ($null -eq $GetTreeEntries) { Get-HermesGitTreePaths $git $store $Lock.sourceCommit $LeaseContext } else { @(& $GetTreeEntries $store $Lock.sourceCommit) }
      if ($Lock.ContainsKey('tag')) {
        $transcriptInvokeGit = $InvokeGit
        if ($null -eq $transcriptInvokeGit) {
          $transcriptGit = $git
          $transcriptLeaseContext = $LeaseContext
          $transcriptInvokeGit = { param([string[]]$Arguments) @(Invoke-GitChecked $transcriptGit $Arguments $transcriptLeaseContext) }.GetNewClosure()
        }
        Assert-HermesGitTranscript $Lock $store $source $transcriptInvokeGit $entries
      }
      $expected = @($entries | ForEach-Object Path)
      $actual = @(Get-ChildItem -LiteralPath $source -Force -File -Recurse | ForEach-Object { $_.FullName.Substring($source.Length).TrimStart('\').Replace('\','/') })
      if (-not (Test-HermesOrdinalPathSetEqual $expected $actual)) { throw 'Pinned source path set drift.' }
      $expectedDirectories = @($expected | ForEach-Object { $parts = $_ -split '/'; for ($index = 1; $index -lt $parts.Count; $index++) { ($parts[0..($index - 1)] -join '/') } } | Sort-Object -CaseSensitive -Unique)
      $actualDirectories = @(Get-ChildItem -LiteralPath $source -Force -Directory -Recurse | ForEach-Object { $_.FullName.Substring($source.Length).TrimStart('\').Replace('\','/') })
      if (-not (Test-HermesOrdinalPathSetEqual $expectedDirectories $actualDirectories)) { throw 'Pinned source directory set drift.' }
      if ($null -ne $AssertWorkTree) { & $AssertWorkTree $store $source $Lock.sourceCommit $entries }
      else {
        foreach ($entry in $entries) {
          $candidateFile = Assert-ChildPath $root (Join-Path $source ([string]$entry.Path).Replace('/', '\'))
          if ((Get-HermesGitBlobObjectId $candidateFile) -cne [string]$entry.Object) { throw 'Pinned source Git blob mismatch.' }
        }
      }
    } finally { if ($null -ne $tagGuard) { $tagGuard.Dispose() }; $headGuard.Dispose(); $configGuard.Dispose() }
  }
  if ($null -ne $Boundary) { & $Boundary 'before-source-readonly-snapshot-final' }
  $sourceVerified = $true
  } finally {
    try { if ($sourceVerified) { Assert-HermesReadOnlyTreeSnapshot $sourceSnapshot } }
    finally { Exit-HermesReadOnlyTreeSnapshot $sourceSnapshot }
  }
}

function Assert-ArtifactHttpHop {
  param([hashtable]$Artifact, [Uri]$RequestUri, [int]$StatusCode, [Uri]$Location, [Nullable[int64]]$ContentLength)
  $allowed = @('github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'raw.githubusercontent.com')
  if ($RequestUri.Scheme -ne 'https' -or $RequestUri.Host -notin $allowed) { throw 'Artifact URL is not an approved HTTPS host.' }
  if ($StatusCode -in 301,302,303,307,308) { if ($null -eq $Location -or $Location.Scheme -ne 'https' -or $Location.Host -notin $allowed) { throw 'Artifact redirect is not an approved HTTPS host.' }; return $Location }
  if ($StatusCode -lt 200 -or $StatusCode -gt 299) { throw 'Artifact download returned a non-success status.' }
  if ($null -ne $ContentLength -and [int64]$ContentLength -ne [int64]$Artifact.size) { throw 'Artifact content length drift.' }
  return $null
}

function Assert-SafeCpythonMembers {
  param([object[]]$Members)
  $types = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($member in $Members) {
    $name = [string]$member.Name
    $type = [string]$member.Type
    if ($type -cnotin @('-', 'd')) { throw 'CPython archive contains a link or unsupported member type.' }
    if ($name.Contains('\') -or (Test-UnsafeArchiveMember $name)) { throw 'CPython archive has an unsafe or separator-alias member.' }
    $canonical = $name.TrimEnd('/')
    if ($canonical -cne 'python' -and -not $canonical.StartsWith('python/', [StringComparison]::Ordinal)) { throw 'CPython archive has an unsafe or unexpected member.' }
    if ($types.ContainsKey($canonical)) { throw 'CPython archive has duplicate, case-colliding, or file-directory alias members.' }
    $segments = $canonical.Split('/')
    for ($count = 1; $count -lt $segments.Count; $count++) {
      $ancestor = $segments[0..($count - 1)] -join '/'
      if ($types.ContainsKey($ancestor) -and $types[$ancestor] -cne 'd') { throw 'CPython archive has a file ancestor of another member.' }
    }
    if ($type -cne 'd') {
      foreach ($existing in @($types.Keys)) { if ($existing.StartsWith(($canonical + '/'), [StringComparison]::OrdinalIgnoreCase)) { throw 'CPython archive has a file ancestor of another member.' } }
    }
    if ($canonical -ceq 'python' -and $type -cne 'd') { throw 'CPython archive root must be a directory.' }
    $types.Add($canonical, $type)
  }
}

function Assert-SafeUvMembers {
  param([object[]]$Members)
  $expected = @('uv.exe', 'uvw.exe', 'uvx.exe'); $names = @($Members | ForEach-Object { [string]$_.Name })
  if (-not (Test-HermesOrdinalPathSetEqual $expected $names)) { throw 'uv archive has an unexpected member set.' }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($member in $Members) { if (-not $seen.Add([string]$member.Name) -or (Test-UnsafeArchiveMember ([string]$member.Name)) -or ([string]$member.Name) -match '[\\/]' -or [bool]$member.Link) { throw 'uv archive has an unsafe member.' } }
}

function Assert-SafeCpythonArchive {
  param([string]$Archive)
  $names = @(& tar.exe -tf $Archive 2>&1); if ($LASTEXITCODE -ne 0) { throw 'CPython archive listing failed.' }
  $verbose = @(& tar.exe -tvf $Archive 2>&1); if ($LASTEXITCODE -ne 0 -or $names.Count -ne $verbose.Count) { throw 'CPython archive metadata listing failed.' }
  $members = for ($index = 0; $index -lt $names.Count; $index++) { [pscustomobject]@{ Name = $names[$index].ToString(); Type = $verbose[$index].ToString()[0] } }
  Assert-SafeCpythonMembers $members
}

function Assert-SafeUvArchive {
  param([string]$Archive)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $members = @($zip.Entries | ForEach-Object { [pscustomobject]@{ Name = $_.FullName; Link = ((($_.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) } })
    Assert-SafeUvMembers $members
  } finally { $zip.Dispose() }
}

function New-HermesArtifactSnapshotStream {
  param(
    [string]$Archive,
    [string]$ExpectedSha256 = '',
    [Nullable[int64]]$ExpectedSize = $null,
    [scriptblock]$BeforeSnapshotCopy = $null
  )
  $maximumSnapshotBytes = 64MB
  $archiveFull = [IO.Path]::GetFullPath($Archive)
  if (-not [string]::IsNullOrEmpty($ExpectedSha256) -and $ExpectedSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Artifact snapshot expected hash is invalid.' }
  if ($null -ne $ExpectedSize -and ($ExpectedSize -lt 1 -or $ExpectedSize -gt $maximumSnapshotBytes)) { throw 'Artifact snapshot expected size exceeds the exact in-memory bound.' }
  $sourceGuard = $null
  $source = $null
  $snapshot = $null
  try {
    $source = [IO.File]::Open($archiveFull, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $sourceLength = [int64]$source.Length
    if ($sourceLength -lt 1 -or $sourceLength -gt $maximumSnapshotBytes) { throw 'Artifact source exceeds the exact in-memory snapshot bound.' }
    if ($null -ne $ExpectedSize -and $sourceLength -ne [int64]$ExpectedSize) { throw 'Artifact source byte count drift.' }
    $sourceGuard = Open-HermesSafeIdentity $archiveFull
    if ([uint64]$sourceLength -ne [uint64]$sourceGuard.Size) { throw 'Artifact identity changed after its restrictive source handle opened.' }
    if ($null -ne $BeforeSnapshotCopy) { & $BeforeSnapshotCopy }
    $snapshot = [IO.MemoryStream]::new([int]$sourceLength)
    $buffer = [byte[]]::new(131072)
    $remaining = $sourceLength
    while ($remaining -gt 0) {
      $read = $source.Read($buffer, 0, [int][Math]::Min([int64]$buffer.Length, $remaining))
      if ($read -le 0) { throw 'Artifact source was truncated while creating its snapshot.' }
      $snapshot.Write($buffer, 0, $read)
      $remaining -= $read
    }
    if ($source.ReadByte() -ne -1) { throw 'Artifact source grew while creating its bounded snapshot.' }
    if ($snapshot.Length -ne $sourceLength -or ($null -ne $ExpectedSize -and $snapshot.Length -ne [int64]$ExpectedSize)) { throw 'Artifact snapshot byte count drift.' }
    if (-not [string]::IsNullOrEmpty($ExpectedSha256)) {
      $snapshot.Position = 0
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $actual = ([Convert]::ToHexString($sha.ComputeHash($snapshot))).ToLowerInvariant() } finally { $sha.Dispose() }
      if ($actual -cne $ExpectedSha256) { throw 'Artifact snapshot hash drift.' }
    }
    $snapshot.Position = 0
    $result = $snapshot
    $snapshot = $null
    return $result
  } catch {
    if ($null -ne $snapshot) { $snapshot.Dispose(); $snapshot = $null }
    throw
  } finally {
    if ($null -ne $source) { $source.Dispose() }
    if ($null -ne $sourceGuard) { $sourceGuard.Dispose() }
  }
}

function Get-HermesCpythonMembersFromStream {
  param([IO.Stream]$ArtifactStream)
  $ArtifactStream.Position = 0
  $first = $ArtifactStream.ReadByte(); $second = $ArtifactStream.ReadByte(); $ArtifactStream.Position = 0
  $payload = if ($first -eq 0x1f -and $second -eq 0x8b) { [IO.Compression.GZipStream]::new($ArtifactStream, [IO.Compression.CompressionMode]::Decompress, $true) } else { $ArtifactStream }
  $reader = [System.Formats.Tar.TarReader]::new($payload, $true)
  try {
    $members = [Collections.Generic.List[object]]::new()
    while ($null -ne ($entry = $reader.GetNextEntry())) {
      $type = switch ($entry.EntryType) {
        ([System.Formats.Tar.TarEntryType]::Directory) { 'd'; break }
        ([System.Formats.Tar.TarEntryType]::RegularFile) { '-'; break }
        ([System.Formats.Tar.TarEntryType]::V7RegularFile) { '-'; break }
        default { [string]$entry.EntryType; break }
      }
      $members.Add([pscustomobject]@{ Name = [string]$entry.Name; Type = $type })
    }
    return @($members)
  } finally {
    $reader.Dispose()
    if (-not [object]::ReferenceEquals($payload, $ArtifactStream)) { $payload.Dispose() }
  }
}

function Expand-HermesCpythonArchiveIdentityStable {
  param(
    [string]$Archive,
    [string]$StableRoot,
    [string]$Destination,
    [string]$ExpectedSha256 = '',
    [Nullable[int64]]$ExpectedSize = $null,
    [scriptblock]$BeforeSnapshotCopy = $null,
    [scriptblock]$AfterValidation = $null,
    [scriptblock]$BeforeFileCreate = $null,
    [pscustomobject]$LeaseContext = $null
  )
  $destinationFull = [IO.Path]::GetFullPath($Destination)
  $ownsLeaseContext = $null -eq $LeaseContext
  $leaseContext = if ($ownsLeaseContext) { Enter-HermesExtractionLeaseChain -StableRoot $StableRoot -Destination $destinationFull } else { $LeaseContext }
  if (-not $ownsLeaseContext) {
    $contextRoot = Assert-HermesContainmentContext $leaseContext
    [void](Assert-ChildPath $contextRoot $destinationFull)
    if (-not (Test-HermesContainedDirectory $leaseContext $destinationFull)) { throw 'CPython extraction destination is not retained by the shared write-containment context.' }
  }
  try {
    if (@(Get-ChildItem -LiteralPath $destinationFull -Force).Count -ne 0) { throw 'CPython extraction destination must be an existing empty directory.' }
    $snapshot = New-HermesArtifactSnapshotStream -Archive $Archive -ExpectedSha256 $ExpectedSha256 -ExpectedSize $ExpectedSize -BeforeSnapshotCopy $BeforeSnapshotCopy
    try {
      $members = @(Get-HermesCpythonMembersFromStream $snapshot)
      Assert-SafeCpythonMembers $members
      if ($null -ne $AfterValidation) { & $AfterValidation }
      $snapshot.Position = 0
      $first = $snapshot.ReadByte(); $second = $snapshot.ReadByte(); $snapshot.Position = 0
      $payload = if ($first -eq 0x1f -and $second -eq 0x8b) { [IO.Compression.GZipStream]::new($snapshot, [IO.Compression.CompressionMode]::Decompress, $true) } else { $snapshot }
      $reader = [System.Formats.Tar.TarReader]::new($payload, $true)
      try {
        $index = 0
        while ($null -ne ($entry = $reader.GetNextEntry())) {
          if ($index -ge $members.Count -or [string]$entry.Name -cne [string]$members[$index].Name) { throw 'CPython archive identity produced an inconsistent member transcript.' }
          $index++
          $relative = ([string]$entry.Name).TrimEnd('/').Replace('/','\')
          $target = Assert-ChildPath $destinationFull (Join-Path $destinationFull $relative)
          $isDirectory = $entry.EntryType -eq [System.Formats.Tar.TarEntryType]::Directory
          $parent = if ($isDirectory) { $target } else { [IO.Directory]::GetParent($target).FullName }
          $parentRelative = $parent.Substring($destinationFull.Length).TrimStart('\')
          $cursor = $destinationFull
          foreach ($segment in @($parentRelative -split '\\' | Where-Object { -not [string]::IsNullOrEmpty($_) })) {
            $cursor = Join-Path $cursor $segment
            if ($ownsLeaseContext) {
              if (-not (Test-Path -LiteralPath $cursor)) { New-Item -ItemType Directory -Path $cursor | Out-Null }
              if (-not $leaseContext.Paths.Contains($cursor)) { Add-HermesExtractionDirectoryLease -Context $leaseContext -Path $cursor }
            } else { [void](New-HermesLeasedDirectory $leaseContext $cursor -MovableLeaf:($cursor -ceq (Join-Path $destinationFull 'python'))) }
          }
          if ($isDirectory) { continue }
          if ($null -ne $BeforeFileCreate) { & $BeforeFileCreate $target }
          $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
          try { if ($null -ne $entry.DataStream) { $entry.DataStream.CopyTo($output, 131072) }; $output.Flush($true) } finally { $output.Dispose() }
        }
        if ($index -ne $members.Count) { throw 'CPython archive identity produced a truncated member transcript.' }
      } finally {
        $reader.Dispose()
        if (-not [object]::ReferenceEquals($payload, $snapshot)) { $payload.Dispose() }
      }
      Assert-HermesSafeTree $destinationFull $destinationFull 'CPython extracted tree' $(if ($ownsLeaseContext) { $null } else { $leaseContext })
    } finally { $snapshot.Dispose() }
  } finally { if ($ownsLeaseContext) { Exit-HermesExtractionLeaseChain $leaseContext } }
}

function Expand-HermesUvArchiveIdentityStable {
  param(
    [string]$Archive,
    [string]$StableRoot,
    [string]$Destination,
    [string]$ExpectedSha256 = '',
    [Nullable[int64]]$ExpectedSize = $null,
    [scriptblock]$BeforeSnapshotCopy = $null,
    [scriptblock]$AfterValidation = $null,
    [scriptblock]$BeforeFileCreate = $null,
    [pscustomobject]$LeaseContext = $null
  )
  $destinationFull = [IO.Path]::GetFullPath($Destination)
  $ownsLeaseContext = $null -eq $LeaseContext
  $leaseContext = if ($ownsLeaseContext) { Enter-HermesExtractionLeaseChain -StableRoot $StableRoot -Destination $destinationFull } else { $LeaseContext }
  if (-not $ownsLeaseContext) {
    $contextRoot = Assert-HermesContainmentContext $leaseContext
    [void](Assert-ChildPath $contextRoot $destinationFull)
    if (-not (Test-HermesContainedDirectory $leaseContext $destinationFull)) { throw 'uv extraction destination is not retained by the shared write-containment context.' }
  }
  try {
    if (@(Get-ChildItem -LiteralPath $destinationFull -Force).Count -ne 0) { throw 'uv extraction destination must be an existing empty directory.' }
    $snapshot = New-HermesArtifactSnapshotStream -Archive $Archive -ExpectedSha256 $ExpectedSha256 -ExpectedSize $ExpectedSize -BeforeSnapshotCopy $BeforeSnapshotCopy
    try {
      $snapshot.Position = 0
      $zip = [IO.Compression.ZipArchive]::new($snapshot, [IO.Compression.ZipArchiveMode]::Read, $true)
      try {
        $members = @($zip.Entries | ForEach-Object { [pscustomobject]@{ Name = $_.FullName; Link = ((($_.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) } })
        Assert-SafeUvMembers $members
      } finally { $zip.Dispose() }

      if ($null -ne $AfterValidation) { & $AfterValidation }
      $snapshot.Position = 0
      $zip = [IO.Compression.ZipArchive]::new($snapshot, [IO.Compression.ZipArchiveMode]::Read, $true)
      try {
        foreach ($entry in $zip.Entries) {
          $target = Assert-ChildPath $destinationFull (Join-Path $destinationFull ([string]$entry.FullName))
          if ($null -ne $BeforeFileCreate) { & $BeforeFileCreate $target }
          $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
          $input = $entry.Open()
          try { $input.CopyTo($output, 131072); $output.Flush($true) } finally { $input.Dispose(); $output.Dispose() }
        }
      } finally { $zip.Dispose() }
      Assert-HermesSafeTree $destinationFull $destinationFull 'uv extracted tree' $(if ($ownsLeaseContext) { $null } else { $leaseContext })
    } finally { $snapshot.Dispose() }
  } finally { if ($ownsLeaseContext) { Exit-HermesExtractionLeaseChain $leaseContext } }
}

function Promote-StagedDirectory {
  param([string]$RuntimeRoot, [string]$StagedDirectory, [string]$FinalDirectory, [pscustomobject]$LeaseContext = $null, [scriptblock]$MutationBoundary = $null, [scriptblock]$ValidationBoundary = $null)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $scope = Enter-HermesContainmentScope $root $LeaseContext
  try {
    $staged = Assert-ChildPath $root $StagedDirectory
    $final = Assert-ChildPath $root $FinalDirectory
    if (-not (Test-Path -LiteralPath $staged -PathType Container)) { throw 'Verified staging directory is absent.' }
    if (Test-Path -LiteralPath $final) { throw 'Final target already exists; promotion refuses replacement.' }
    [void](Add-HermesDirectoryTreeLeases $scope.Context $staged -MovableRoot)
    [void](New-HermesLeasedDirectory $scope.Context ([IO.Directory]::GetParent($final).FullName))
    Move-HermesLeasedDirectoryNoReplace $scope.Context $staged $final $MutationBoundary $ValidationBoundary
    if (-not (Test-Path -LiteralPath $final -PathType Container)) { throw 'Atomic promotion did not create the final target.' }
  } finally { Exit-HermesContainmentScope $scope }
}

function Get-HermesPublicationJournalPath {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  return Assert-ChildPath $root (Join-Path $root '.hermes-runtime-publication.json')
}

function Get-HermesPublicationReadyPath {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  return Assert-ChildPath $root (Join-Path $root '.hermes-runtime-publication.ready.json')
}

function Get-HermesWorkflowLockPath {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  return Assert-ChildPath $root (Join-Path $root '.hermes-runtime.workflow.lock')
}

function Enter-HermesWorkflowLock {
  param([string]$RuntimeRoot)
  $root = Assert-HermesExactRuntimeRoot $RuntimeRoot
  $volumeRoot = [IO.Path]::GetPathRoot($root)
  $parent = [IO.Directory]::GetParent($root).FullName
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'RuntimeRoot parent must already exist for bounded atomic acquisition.' }
  $paths = [Collections.Generic.List[string]]::new()
  $cursor = $volumeRoot.TrimEnd('\')
  foreach ($segment in @($root.Substring($volumeRoot.Length).TrimEnd('\') -split '\\' | Where-Object { -not [string]::IsNullOrEmpty($_) })) {
    $cursor = Join-Path $cursor $segment
    $paths.Add($cursor)
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(1)
  while ($true) {
    $leases = [Collections.Generic.List[object]]::new()
    $workflow = $null
    try {
      for ($index = 0; $index -lt $paths.Count; $index++) {
        $path = $paths[$index]
        if (-not (Test-Path -LiteralPath $path)) {
          if ($index -ne $paths.Count - 1) { throw 'RuntimeRoot has an absent ancestor and cannot be atomically acquired.' }
          [HermesRuntime.NativeFileGuard]::CreateDirectoryNew($path)
        }
        $lease = [HermesRuntime.NativeFileGuard]::OpenDirectoryLease($path)
        try { Assert-HermesDirectoryLease $lease 'Workflow acquisition ancestor' } catch { $lease.Dispose(); throw }
        $leases.Add($lease)
      }
      $workflow = [HermesRuntime.NativeFileGuard]::OpenWorkflowLock((Join-Path $root '.hermes-runtime.workflow.lock'))
      for ($index = $leases.Count - 1; $index -ge 0; $index--) { $leases[$index].Dispose() }
      return $workflow
    } catch {
      if ($null -ne $workflow) { $workflow.Dispose() }
      for ($index = $leases.Count - 1; $index -ge 0; $index--) { $leases[$index].Dispose() }
      $exception = $_.Exception
      $nativeError = 0
      while ($null -ne $exception) {
        if ($exception -is [ComponentModel.Win32Exception]) { $nativeError = $exception.NativeErrorCode; break }
        $exception = $exception.InnerException
      }
      if ($nativeError -notin 32,33 -or [DateTime]::UtcNow -ge $deadline) {
        if ($nativeError -in 32,33) { throw 'Another Hermes acquisition or verification workflow holds the exclusive RuntimeRoot lock.' }
        throw
      }
      Start-Sleep -Milliseconds 20
    }
  }
}

function Get-HermesDirectoryDigest {
  param([string]$RuntimeRoot, [string]$Directory, [pscustomobject]$LeaseContext = $null, [scriptblock]$AfterFileHash = $null)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $directoryFull = Assert-ChildPath $root $Directory
  if (-not (Test-Path -LiteralPath $directoryFull -PathType Container)) { throw 'Publication digest directory is absent.' }
  $records = [Collections.Generic.List[string]]::new()
  if ($null -ne $LeaseContext -and $LeaseContext.Leases.ContainsKey($directoryFull)) { $directoryGuard = $LeaseContext.Leases[$directoryFull]; Assert-HermesDirectoryLease $directoryGuard 'Publication digest directory'; $records.Add("r`t$($directoryGuard.Identity)") }
  else { $directoryGuard = Open-HermesSafeIdentity $directoryFull -Directory; try { $records.Add("r`t$($directoryGuard.Identity)") } finally { $directoryGuard.Dispose() } }
  $items = [Collections.Generic.SortedDictionary[string,IO.FileSystemInfo]]::new([StringComparer]::Ordinal)
  foreach ($item in @(Get-ChildItem -LiteralPath $directoryFull -Force -Recurse)) {
    $relative = $item.FullName.Substring($directoryFull.Length).TrimStart('\').Replace('\','/')
    $items.Add($relative, $item)
  }
  foreach ($entry in $items.GetEnumerator()) {
    $relative = $entry.Key
    $item = $entry.Value
    $ownedGuard = $false
    if ($item.PSIsContainer -and $null -ne $LeaseContext -and $LeaseContext.Leases.ContainsKey($item.FullName)) { $guard = $LeaseContext.Leases[$item.FullName]; Assert-HermesDirectoryLease $guard 'Publication digest directory' }
    else { $guard = Open-HermesSafeIdentity $item.FullName -Directory:$item.PSIsContainer; $ownedGuard = $true }
    try {
      if ($item.PSIsContainer) { $records.Add("d`t$relative`t$($guard.Identity)") }
      else {
        $fileHash = Get-Sha256Hex $item.FullName
        $records.Add("f`t$relative`t$($guard.Identity)`t$($guard.Size)`t$fileHash")
        if ($null -ne $AfterFileHash) { & $AfterFileHash $relative }
      }
    } finally { if ($ownedGuard) { $guard.Dispose() } }
  }
  $payload = [Text.UTF8Encoding]::new($false).GetBytes(($records -join "`n") + "`n")
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([Convert]::ToHexString($sha.ComputeHash($payload))).ToLowerInvariant() } finally { $sha.Dispose() }
}

function Sync-HermesPublicationPayload {
  param([string]$RuntimeRoot, [string]$Directory, [pscustomobject]$LeaseContext = $null)
  # Durability is bounded to NTFS/Windows and storage honoring FlushFileBuffers and MOVEFILE_WRITE_THROUGH.
  # The committed marker is emitted only after these payload and namespace barriers complete.
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $directoryFull = Assert-ChildPath $root $Directory
  Assert-HermesSafeTree $root $directoryFull 'Runtime publication payload' $LeaseContext
  $files = [Collections.Generic.SortedDictionary[string,IO.FileInfo]]::new([StringComparer]::Ordinal)
  foreach ($item in @(Get-ChildItem -LiteralPath $directoryFull -Force -File -Recurse)) {
    $relative = $item.FullName.Substring($directoryFull.Length).TrimStart('\').Replace('\','/')
    $files.Add($relative, $item)
  }
  foreach ($item in $files.Values) {
    $guard = Open-HermesSafeIdentity $item.FullName
    $stream = $null
    try {
      $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
      if ([uint64]$stream.Length -ne [uint64]$guard.Size) { throw 'Runtime publication payload identity changed before its durability barrier.' }
      $stream.Flush($true)
    } finally {
      if ($null -ne $stream) { $stream.Dispose() }
      $guard.Dispose()
    }
  }
  Assert-HermesSafeTree $root $directoryFull 'Runtime publication payload' $LeaseContext
}

function ConvertTo-HermesStateJson {
  param([hashtable]$Record)
  return ($Record | ConvertTo-Json -Compress -Depth 16) + "`n"
}

function Read-HermesStateRecord {
  param([string]$Path, [string]$Label)
  $guard = Open-HermesSafeIdentity $Path
  try { $bytes = [IO.File]::ReadAllBytes($Path) } finally { $guard.Dispose() }
  if ($bytes.Length -lt 3 -or ($bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf)) { throw "$Label is not canonical UTF-8 JSON." }
  $utf8 = [Text.UTF8Encoding]::new($false, $true)
  try { $text = $utf8.GetString($bytes) } catch { throw "$Label is not canonical UTF-8 JSON." }
  if ($text.Contains("`r") -or -not $text.EndsWith("`n", [StringComparison]::Ordinal) -or $text.EndsWith("`n`n", [StringComparison]::Ordinal)) { throw "$Label is not canonical LF JSON." }
  try { $record = $text | ConvertFrom-Json -AsHashtable -Depth 16 } catch { throw "$Label is malformed." }
  if ($record -isnot [hashtable]) { throw "$Label is invalid." }
  if ((ConvertTo-HermesStateJson $record) -cne $text) { throw "$Label is not exact canonical JSON or contains duplicate keys." }
  return $record
}

function Get-HermesExpectedPromotions {
  param([string]$RuntimeRoot, [string]$CommonStage)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $stage = Assert-ChildPath $root $CommonStage
  return @(
    [ordered]@{ staged = (Assert-ChildPath $root (Join-Path $stage 'promote\cpython-3.11.16')); final = (Assert-ChildPath $root (Join-Path $root 'toolchain\cpython-3.11.16')) },
    [ordered]@{ staged = (Assert-ChildPath $root (Join-Path $stage 'promote\uv-0.12.7')); final = (Assert-ChildPath $root (Join-Path $root 'toolchain\uv-0.12.7')) },
    [ordered]@{ staged = (Assert-ChildPath $root (Join-Path $stage 'promote\winsw-2.12.0')); final = (Assert-ChildPath $root (Join-Path $root 'service-host\winsw-2.12.0')) },
    [ordered]@{ staged = (Assert-ChildPath $root (Join-Path $stage 'promote\20260825')); final = (Assert-ChildPath $root (Join-Path $root 'licenses\python-build-standalone\20260825')) }
  )
}

function Assert-HermesPublicationRecord {
  param([string]$RuntimeRoot, [hashtable]$Record, [ValidateSet('promoting','committed')][string]$State)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $schemaVersionIsExactInteger = (($Record.schemaVersion -is [int]) -or ($Record.schemaVersion -is [long])) -and ([long]$Record.schemaVersion -eq 2)
  if ((@($Record.Keys | Sort-Object) -join ',') -cne 'commonStage,promotions,schemaVersion,state,transactionId' -or -not $schemaVersionIsExactInteger -or $Record.state -isnot [string] -or $Record.state -cne $State -or $Record.transactionId -isnot [string] -or $Record.transactionId -cnotmatch '^[a-f0-9]{32}$' -or $Record.commonStage -isnot [string] -or $Record.promotions -isnot [object[]] -or $Record.promotions.Count -ne 4) { throw 'Runtime publication record is not the exact reviewed schema.' }
  $expectedStage = Assert-ChildPath $root (Join-Path $root ('.artifact-stage-' + $Record.transactionId))
  if ($Record.commonStage -cne $expectedStage) { throw 'Runtime publication record has an unbound common stage.' }
  $expected = Get-HermesExpectedPromotions $root $expectedStage
  $allPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  for ($index = 0; $index -lt 4; $index++) {
    $promotion = $Record.promotions[$index]
    if ($promotion -isnot [Collections.IDictionary] -or (@($promotion.Keys | Sort-Object) -join ',') -cne 'digest,final,staged' -or $promotion.digest -isnot [string] -or $promotion.digest -cnotmatch '^[a-f0-9]{64}$' -or $promotion.staged -isnot [string] -or $promotion.staged -cne $expected[$index].staged -or $promotion.final -isnot [string] -or $promotion.final -cne $expected[$index].final) { throw 'Runtime publication record has a forged or reordered promotion.' }
    foreach ($path in @($promotion.staged, $promotion.final)) { if (-not $allPaths.Add($path)) { throw 'Runtime publication record has overlapping paths.' } }
  }
  return $Record
}

function Write-HermesAtomicStateRecord {
  param([string]$RuntimeRoot, [string]$Destination, [hashtable]$Record, [string]$TemporaryPrefix, [pscustomobject]$LeaseContext, [scriptblock]$MoveBoundary = $null, [scriptblock]$TemporaryWrittenBoundary = $null, [scriptblock]$AfterStateHandleDisposedBoundary = $null)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  if ((Assert-HermesContainmentContext $LeaseContext) -cne $root) { throw 'Publication state containment is bound to a different RuntimeRoot.' }
  $destinationFull = Assert-HermesContainedParent $LeaseContext (Assert-ChildPath $root $Destination)
  if (Test-Path -LiteralPath $destinationFull) { throw 'Runtime publication state already exists.' }
  $temporary = Assert-HermesContainedParent $LeaseContext (Assert-ChildPath $root (Join-Path $root ($TemporaryPrefix + [guid]::NewGuid().ToString('N') + '.tmp')))
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-HermesStateJson $Record))
  $stateFile = $null
  $moved = $false
  $failure = $null
  $cleanupFailure = $null
  try {
    $stateFile = [HermesRuntime.NativeAtomicStateFile]::CreateNew($temporary)
    $stateFile.WriteExact($bytes)
    if ($null -ne $TemporaryWrittenBoundary) { & $TemporaryWrittenBoundary $temporary $destinationFull }
    $temporaryIdentity = Open-HermesSafeObservationIdentity $temporary
    try {
      if ([string]$temporaryIdentity.Identity -cne [string]$stateFile.Identity -or [uint64]$temporaryIdentity.Size -ne [uint64]$bytes.LongLength -or -not $stateFile.Matches($bytes)) { throw 'Atomic publication state temporary identity or bytes changed.' }
    } finally { $temporaryIdentity.Dispose() }
    if ($null -ne $MoveBoundary) { & $MoveBoundary $temporary $destinationFull }
    $temporaryIdentity = Open-HermesSafeObservationIdentity $temporary
    try {
      if ([string]$temporaryIdentity.Identity -cne [string]$stateFile.Identity -or [uint64]$temporaryIdentity.Size -ne [uint64]$bytes.LongLength -or -not $stateFile.Matches($bytes)) { throw 'Atomic publication state changed before its identity-bound move.' }
    } finally { $temporaryIdentity.Dispose() }
    $stateFile.MoveToNoReplace($destinationFull)
    $moved = $true
    $destinationIdentity = Open-HermesSafeObservationIdentity $destinationFull
    try {
      if ([string]$destinationIdentity.Identity -cne [string]$stateFile.Identity -or [uint64]$destinationIdentity.Size -ne [uint64]$bytes.LongLength -or -not $stateFile.Matches($bytes)) { throw 'Atomic publication state destination is not the exact created identity and bytes.' }
    } finally { $destinationIdentity.Dispose() }
    if (-not (Test-Path -LiteralPath $destinationFull -PathType Leaf)) { throw 'Atomic publication state promotion failed.' }
  } catch {
    $failure = $_
    if ($null -ne $stateFile) { try { $stateFile.DeleteByHandle() } catch { $cleanupFailure = $_ } }
  } finally {
    if ($null -ne $stateFile) { $stateFile.Dispose() }
    if ($null -ne $AfterStateHandleDisposedBoundary) { & $AfterStateHandleDisposedBoundary $temporary $destinationFull }
  }
  if ($null -ne $failure -and $moved -and (Test-Path -LiteralPath $destinationFull)) { throw 'Atomic publication state cleanup failed closed.' }
  if ($null -ne $cleanupFailure) { throw 'Atomic publication state cleanup failed closed.' }
  if ($null -ne $failure) { throw $failure }
}

function Write-HermesPublicationJournal {
  param([string]$RuntimeRoot, [object[]]$Promotions, [pscustomobject]$LeaseContext)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $journal = Get-HermesPublicationJournalPath $RuntimeRoot
  if (Test-Path -LiteralPath $journal) { throw 'Runtime publication journal already exists.' }
  if ($Promotions.Count -ne 4) { throw 'Runtime publication requires exactly four promotions.' }
  $commonStage = [IO.Directory]::GetParent([IO.Directory]::GetParent([string]$Promotions[0].StagedDirectory).FullName).FullName
  $transactionId = [IO.Path]::GetFileName($commonStage).Substring('.artifact-stage-'.Length)
  $record = [ordered]@{
    schemaVersion = 2
    state = 'promoting'
    transactionId = $transactionId
    commonStage = $commonStage
    promotions = @($Promotions | ForEach-Object { [ordered]@{ staged = [string]$_.StagedDirectory; final = [string]$_.FinalDirectory; digest = (Get-HermesDirectoryDigest $root ([string]$_.StagedDirectory) $LeaseContext) } })
  }
  [void](Assert-HermesPublicationRecord $root $record 'promoting')
  Write-HermesAtomicStateRecord $root $journal $record '.hermes-runtime-publication-' $LeaseContext
  return $journal
}

function Get-HermesPublicationJournalRecord {
  param([string]$RuntimeRoot)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $journal = Get-HermesPublicationJournalPath $root
  if (-not (Test-Path -LiteralPath $journal -PathType Leaf)) { return $null }
  $record = Read-HermesStateRecord $journal 'Runtime publication journal'
  [void](Assert-HermesPublicationRecord $root $record 'promoting')
  return $record
}

function Assert-HermesPublicationMarker {
  param([string]$RuntimeRoot, [pscustomobject]$LeaseContext = $null)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $ready = Get-HermesPublicationReadyPath $root
  if (-not (Test-Path -LiteralPath $ready -PathType Leaf)) { throw 'Runtime publication has no verified commit marker.' }
  try { $record = Read-HermesStateRecord $ready 'Runtime publication commit marker' } catch { throw $_ }
  [void](Assert-HermesPublicationRecord $root $record 'committed')
  foreach ($promotion in $record.promotions) {
    $final = Assert-ChildPath $root ([string]$promotion.final)
    $stage = Assert-ChildPath $root ([string]$promotion.staged)
    if ((Test-Path -LiteralPath $stage) -or -not (Test-Path -LiteralPath $final -PathType Container) -or ((Get-Item -LiteralPath $final -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Get-HermesDirectoryDigest $root $final $LeaseContext) -cne [string]$promotion.digest) { throw 'Runtime publication commit marker references a drifted or unsafe final directory.' }
  }
  return $record
}

function Assert-HermesPublicationReady {
  param([string]$RuntimeRoot, [pscustomobject]$LeaseContext = $null)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $journal = Get-HermesPublicationJournalPath $root
  if (Test-Path -LiteralPath $journal) { throw 'Runtime publication is incomplete or recovery is required.' }
  $record = Assert-HermesPublicationMarker $root $LeaseContext
  if (Test-Path -LiteralPath ([string]$record.commonStage)) { throw 'Runtime publication retains committed staging residue.' }
}

function Write-HermesPublicationReady {
  param([string]$RuntimeRoot, [hashtable]$Record, [pscustomobject]$LeaseContext)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot; $ready = Get-HermesPublicationReadyPath $root
  [void](Assert-HermesPublicationRecord $root $Record 'committed')
  Write-HermesAtomicStateRecord $root $ready $Record '.hermes-runtime-publication.ready-' $LeaseContext
}

function Complete-StagedDirectories {
  param([string]$RuntimeRoot, [scriptblock]$Boundary = $null, [pscustomobject]$LeaseContext = $null)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $scope = Enter-HermesContainmentScope $root $LeaseContext
  try {
    $journal = Get-HermesPublicationJournalPath $root
    if (-not (Test-Path -LiteralPath $journal -PathType Leaf)) { throw 'Runtime publication journal is absent.' }
    $record = Read-HermesStateRecord $journal 'Runtime publication journal'
    [void](Assert-HermesPublicationRecord $root $record 'promoting')
    foreach ($promotion in $record.promotions) {
      $stage = Assert-ChildPath $root ([string]$promotion.staged); $final = Assert-ChildPath $root ([string]$promotion.final)
      if (Test-Path -LiteralPath $stage) { throw 'Runtime publication has unpromoted staging.' }
      if (-not (Test-Path -LiteralPath $final -PathType Container)) { throw 'Runtime publication final directory is absent.' }
      [void](Add-HermesDirectoryTreeLeases $scope.Context $final)
      Sync-HermesPublicationPayload $root $final $scope.Context
      if ((Get-HermesDirectoryDigest $root $final $scope.Context) -cne [string]$promotion.digest) { throw 'Runtime publication payload drifted at its durability barrier.' }
    }
    $committed = [ordered]@{ schemaVersion = 2; state = 'committed'; transactionId = $record.transactionId; commonStage = $record.commonStage; promotions = $record.promotions }
    Write-HermesPublicationReady $root $committed $scope.Context
    if ($null -ne $Boundary) { & $Boundary 'marker-written' }
    [void](Assert-HermesPublicationMarker $root $scope.Context)
    if ($null -ne $Boundary) { & $Boundary 'marker-validated' }
    if (Test-Path -LiteralPath ([string]$record.commonStage)) { Remove-HermesContainedTreeNoFollow $scope.Context ([string]$record.commonStage) }
    Remove-HermesContainedFileNoFollow $scope.Context $journal
  } finally { Exit-HermesContainmentScope $scope }
}

function Recover-StagedDirectories {
  param([string]$RuntimeRoot, [pscustomobject]$LeaseContext = $null, [scriptblock]$Boundary = $null)
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $scope = Enter-HermesContainmentScope $root $LeaseContext
  try {
    $journal = Get-HermesPublicationJournalPath $root
    if (-not (Test-Path -LiteralPath $journal -PathType Leaf)) { return }
    $record = Read-HermesStateRecord $journal 'Runtime publication journal'
    [void](Assert-HermesPublicationRecord $root $record 'promoting')
    $ready = Get-HermesPublicationReadyPath $root
    if (Test-Path -LiteralPath $ready) {
      foreach ($promotion in $record.promotions) { if (Test-Path -LiteralPath ([string]$promotion.final) -PathType Container) { [void](Add-HermesDirectoryTreeLeases $scope.Context ([string]$promotion.final)) } }
      $committed = Assert-HermesPublicationMarker $root $scope.Context
      if ([string]$committed.transactionId -cne [string]$record.transactionId -or [string]$committed.commonStage -cne [string]$record.commonStage -or (ConvertTo-HermesStateJson ([ordered]@{ promotions = $committed.promotions })) -cne (ConvertTo-HermesStateJson ([ordered]@{ promotions = $record.promotions }))) { throw 'Runtime publication marker does not bind the recovery journal.' }
      if (Test-Path -LiteralPath ([string]$record.commonStage)) { Remove-HermesContainedTreeNoFollow $scope.Context ([string]$record.commonStage) }
      Remove-HermesContainedFileNoFollow $scope.Context $journal
      return
    }
    $validatedRecovery = @()
    foreach ($promotion in @($record.promotions)[($record.promotions.Count - 1)..0]) {
      $stage = Assert-ChildPath $root ([string]$promotion.staged); $final = Assert-ChildPath $root ([string]$promotion.final)
      $stageExists = Test-Path -LiteralPath $stage -PathType Container
      $finalExists = Test-Path -LiteralPath $final -PathType Container
      if ($stageExists -eq $finalExists) { throw 'Runtime publication recovery requires exactly one staging or final directory.' }
      $present = if ($finalExists) { $final } else { $stage }
      [void](Add-HermesDirectoryTreeLeases $scope.Context $present -MovableRoot)
      if ((Get-HermesDirectoryDigest $root $present $scope.Context) -cne [string]$promotion.digest) { throw 'Runtime publication recovery found a drifted staged or final directory digest.' }
      $validatedRecovery += [pscustomobject]@{ Stage = $stage; Final = $final; FinalExists = $finalExists; Digest = [string]$promotion.digest }
    }
    $recoveryIndex = 0
    foreach ($promotion in $validatedRecovery) {
      if (-not $promotion.FinalExists) { continue }
      [void](New-HermesLeasedDirectory $scope.Context ([IO.Directory]::GetParent($promotion.Stage).FullName))
      $recoveryIndex++
      if ($null -ne $Boundary) { & $Boundary ("before-recovery-{0}" -f $recoveryIndex) }
      $recoveryWindow = if ($null -eq $Boundary) { $null } else { { & $Boundary ("during-recovery-{0}-parent-window" -f $recoveryIndex) }.GetNewClosure() }
      Move-HermesLeasedDirectoryNoReplace $scope.Context $promotion.Final $promotion.Stage $recoveryWindow
      if ((Get-HermesDirectoryDigest $root $promotion.Stage $scope.Context) -cne $promotion.Digest) { throw 'Runtime publication recovery move changed the recorded directory digest.' }
    }
    if (Test-Path -LiteralPath ([string]$record.commonStage)) { Remove-HermesContainedTreeNoFollow $scope.Context ([string]$record.commonStage) }
    Remove-HermesContainedFileNoFollow $scope.Context $journal
  } finally { Exit-HermesContainmentScope $scope }
}

function Assert-NoHermesWorkflowResidue {
  param([string]$RuntimeRoot, [string]$BoundStage = '')
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { return }
  $bound = if ([string]::IsNullOrEmpty($BoundStage)) { '' } else { Assert-ChildPath $root $BoundStage }
  foreach ($item in @(Get-ChildItem -LiteralPath $root -Force)) {
    $isResidue = $item.Name.StartsWith('.artifact-stage-', [StringComparison]::OrdinalIgnoreCase) -or $item.Name.StartsWith('.verify-', [StringComparison]::OrdinalIgnoreCase) -or $item.Name -match '^\.hermes-runtime-publication(?:\.ready)?-[a-f0-9]{32}\.tmp$'
    if ($isResidue -and ([string]::IsNullOrEmpty($bound) -or $item.FullName -cne $bound)) { throw 'RuntimeRoot contains unbound workflow residue.' }
    if ($item.Name -ieq '.s' -and ([string]::IsNullOrEmpty($bound) -or $item.FullName -cne $bound)) { throw 'RuntimeRoot contains unbound source staging residue.' }
  }
}

function Promote-StagedDirectories {
  param(
    [string]$RuntimeRoot,
    [object[]]$Promotions,
    [int]$FaultAfterPromotion = 0,
    [int]$CrashAfterPromotion = 0,
    [scriptblock]$Boundary = $null,
    [pscustomobject]$LeaseContext = $null
  )
  $root = Assert-LiteralRuntimeRoot $RuntimeRoot
  $scope = Enter-HermesContainmentScope $root $LeaseContext
  try {
    if ($Promotions.Count -lt 1) { throw 'At least one staged promotion is required.' }
    $checked = @()
    foreach ($promotion in $Promotions) {
      if ($null -eq $promotion -or $promotion.PSObject.Properties.Name -notcontains 'StagedDirectory' -or $promotion.PSObject.Properties.Name -notcontains 'FinalDirectory') { throw 'Promotion must name staged and final directories.' }
      $staged = Assert-ChildPath $root ([string]$promotion.StagedDirectory)
      $final = Assert-ChildPath $root ([string]$promotion.FinalDirectory)
      if (-not (Test-Path -LiteralPath $staged -PathType Container)) { throw 'Verified staging directory is absent.' }
      if (Test-Path -LiteralPath $final) { throw 'Final target already exists; promotion refuses replacement.' }
      [void](Add-HermesDirectoryTreeLeases $scope.Context $staged -MovableRoot)
      [void](New-HermesLeasedDirectory $scope.Context ([IO.Directory]::GetParent($final).FullName))
      $checked += [pscustomobject]@{ StagedDirectory = $staged; FinalDirectory = $final }
    }
    foreach ($promotion in $checked) { Sync-HermesPublicationPayload $root $promotion.StagedDirectory $scope.Context }
    [void](Write-HermesPublicationJournal $root $checked $scope.Context)
    $promoted = @()
    try {
      foreach ($promotion in $checked) {
        $promotionIndex = $promoted.Count + 1
        if ($null -ne $Boundary) { & $Boundary ("before-promotion-{0}" -f $promotionIndex) }
        $promotionWindow = if ($null -eq $Boundary) { $null } else { { & $Boundary ("during-promotion-{0}-parent-window" -f $promotionIndex) }.GetNewClosure() }
        $validationWindow = if ($null -eq $Boundary) { $null } else { { param([string]$Relative) & $Boundary ("during-promotion-{0}-validation-after-{1}" -f $promotionIndex, $Relative) }.GetNewClosure() }
        Move-HermesLeasedDirectoryNoReplace $scope.Context $promotion.StagedDirectory $promotion.FinalDirectory $promotionWindow $validationWindow
        $promoted += $promotion
        if ($null -ne $Boundary) { & $Boundary ("promotion-{0}" -f $promoted.Count) }
        if ($CrashAfterPromotion -gt 0 -and $promoted.Count -ge $CrashAfterPromotion) { throw 'Injected publication crash.' }
        if ($FaultAfterPromotion -gt 0 -and $promoted.Count -ge $FaultAfterPromotion) { throw 'Injected promotion fault.' }
      }
    } catch {
      $original = $_
      if ($original.Exception.Message -eq 'Injected publication crash.') { throw $original }
      $rollbackCandidates = @($checked)
      [array]::Reverse($rollbackCandidates)
      $rollbackIndex = 0
      $rollbackFailure = $null
      $uncertainState = $false
      foreach ($promotion in $rollbackCandidates) {
        $stageExists = Test-Path -LiteralPath $promotion.StagedDirectory
        $finalExists = Test-Path -LiteralPath $promotion.FinalDirectory
        if ($finalExists -and -not $stageExists) {
          try {
            [void](New-HermesLeasedDirectory $scope.Context ([IO.Directory]::GetParent($promotion.StagedDirectory).FullName))
            $rollbackIndex++
            $rollbackWindow = if ($null -eq $Boundary) { $null } else { { & $Boundary ("during-promotion-rollback-{0}-parent-window" -f $rollbackIndex) }.GetNewClosure() }
            Move-HermesLeasedDirectoryNoReplace $scope.Context $promotion.FinalDirectory $promotion.StagedDirectory $rollbackWindow
          } catch { $rollbackFailure = $_; $uncertainState = $true; break }
        } elseif (-not ($stageExists -and -not $finalExists)) {
          $uncertainState = $true
          break
        }
      }
      if (-not $uncertainState) { Remove-HermesContainedFileNoFollow $scope.Context (Get-HermesPublicationJournalPath $root) }
      if ($null -ne $rollbackFailure) { throw "Runtime publication failed and exact outer rollback failed: $($rollbackFailure.Exception.Message)" }
      throw $original
    }
  } finally { Exit-HermesContainmentScope $scope }
}

Export-ModuleMember -Function Assert-LiteralRuntimeRoot, Assert-HermesExactRuntimeRoot, Assert-ChildPath, Assert-HermesTestFixtureRoot, Open-HermesSafeIdentity, Assert-HermesSafeTree, Get-Sha256Hex, Assert-ExactHash, Get-Manifest, Assert-HermesSourceLock, Assert-HermesArtifactLock, Get-HermesTrustedGitExecutable, Invoke-GitChecked, Get-HermesGitTreePaths, Get-HermesGitBlobObjectIdFromBytes, Get-HermesGitBlobObjectId, Assert-HermesGitWorkTreeMatchesCommit, Export-HermesGitBlobsNoClobber, Test-UnsafeArchiveMember, Get-HermesGitIsolationOptions, Get-HermesCanonicalGitConfig, Assert-HermesGitConfig, Assert-HermesDetachedHead, Assert-HermesGitTranscript, Assert-HermesSourceDirectory, Assert-ArtifactHttpHop, Assert-SafeCpythonMembers, Assert-SafeUvMembers, Assert-SafeCpythonArchive, Assert-SafeUvArchive, Expand-HermesCpythonArchiveIdentityStable, Expand-HermesUvArchiveIdentityStable, Promote-StagedDirectory, Get-HermesPublicationJournalPath, Get-HermesPublicationReadyPath, Get-HermesPublicationJournalRecord, Get-HermesWorkflowLockPath, Enter-HermesWorkflowLock, New-HermesWriteContainmentContext, Assert-HermesContainmentContext, Test-HermesOrdinalPathSetEqual, Assert-HermesExactDirectorySpelling, Add-HermesDirectoryLease, New-HermesLeasedDirectory, New-HermesContainedScratchDirectory, Clear-HermesContainedScratchResidue, Assert-NoHermesContainedScratchResidue, Add-HermesDirectoryTreeLeases, Release-HermesDirectoryLeaseSubtree, Enter-HermesGitWritableDirectoryTree, Exit-HermesGitWritableDirectoryTree, Exit-HermesWriteContainment, Open-HermesContainedFileCreateNew, Write-HermesContainedBytesCreateNew, Write-HermesContainedTextCreateNew, Copy-HermesContainedFileCreateNew, Move-HermesContainedFileNoReplace, Move-HermesLeasedDirectoryNoReplace, Remove-HermesContainedFileNoFollow, Remove-HermesContainedTreeNoFollow, Get-HermesDirectoryDigest, Sync-HermesPublicationPayload, Assert-HermesPublicationReady, Complete-StagedDirectories, Recover-StagedDirectories, Assert-NoHermesWorkflowResidue, Promote-StagedDirectories
