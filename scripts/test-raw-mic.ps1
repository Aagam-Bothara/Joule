# Test raw microphone recording via winmm (bypasses System.Speech)
Write-Host "=== Raw Microphone Test ==="
Write-Host ""

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public class MicTest {
    [DllImport("winmm.dll")]
    static extern int waveInOpen(out IntPtr hWaveIn, int deviceId, ref WAVEFORMATEX lpFormat, IntPtr dwCallback, IntPtr dwInstance, int fdwOpen);
    [DllImport("winmm.dll")]
    static extern int waveInPrepareHeader(IntPtr hWaveIn, ref WAVEHDR lpWaveHdr, int uSize);
    [DllImport("winmm.dll")]
    static extern int waveInAddBuffer(IntPtr hWaveIn, ref WAVEHDR lpWaveHdr, int uSize);
    [DllImport("winmm.dll")]
    static extern int waveInStart(IntPtr hWaveIn);
    [DllImport("winmm.dll")]
    static extern int waveInStop(IntPtr hWaveIn);
    [DllImport("winmm.dll")]
    static extern int waveInUnprepareHeader(IntPtr hWaveIn, ref WAVEHDR lpWaveHdr, int uSize);
    [DllImport("winmm.dll")]
    static extern int waveInClose(IntPtr hWaveIn);
    [DllImport("winmm.dll")]
    static extern int waveInGetNumDevs();

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX {
        public short wFormatTag;
        public short nChannels;
        public int nSamplesPerSec;
        public int nAvgBytesPerSec;
        public short nBlockAlign;
        public short wBitsPerSample;
        public short cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEHDR {
        public IntPtr lpData;
        public int dwBufferLength;
        public int dwBytesRecorded;
        public IntPtr dwUser;
        public int dwFlags;
        public int dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }

    public static string Test(int durationMs) {
        int devCount = waveInGetNumDevs();
        if (devCount == 0) return "ERROR: No microphone devices found";

        var fmt = new WAVEFORMATEX();
        fmt.wFormatTag = 1;
        fmt.nChannels = 1;
        fmt.nSamplesPerSec = 16000;
        fmt.wBitsPerSample = 16;
        fmt.nBlockAlign = 2;
        fmt.nAvgBytesPerSec = 32000;
        fmt.cbSize = 0;

        IntPtr hWaveIn;
        int result = waveInOpen(out hWaveIn, -1, ref fmt, IntPtr.Zero, IntPtr.Zero, 0);
        if (result != 0) return "ERROR: waveInOpen failed with code " + result;

        int bufferSize = 32000 * (durationMs / 1000 + 1);
        IntPtr buffer = Marshal.AllocHGlobal(bufferSize);
        var hdr = new WAVEHDR();
        hdr.lpData = buffer;
        hdr.dwBufferLength = bufferSize;

        waveInPrepareHeader(hWaveIn, ref hdr, Marshal.SizeOf(hdr));
        waveInAddBuffer(hWaveIn, ref hdr, Marshal.SizeOf(hdr));
        waveInStart(hWaveIn);

        Console.WriteLine("Recording for " + (durationMs/1000) + " seconds... SPEAK NOW!");
        Thread.Sleep(durationMs);

        waveInStop(hWaveIn);
        Thread.Sleep(100);

        int recorded = hdr.dwBytesRecorded;
        byte[] data = new byte[recorded];
        if (recorded > 0) Marshal.Copy(buffer, data, 0, recorded);

        waveInUnprepareHeader(hWaveIn, ref hdr, Marshal.SizeOf(hdr));
        waveInClose(hWaveIn);
        Marshal.FreeHGlobal(buffer);

        // Analyze audio data
        if (recorded == 0) return "ERROR: No audio data recorded (0 bytes)";

        // Check for silence - compute RMS of samples
        long sumSquares = 0;
        int maxSample = 0;
        int sampleCount = recorded / 2;
        for (int i = 0; i < recorded - 1; i += 2) {
            short sample = (short)(data[i] | (data[i+1] << 8));
            int abs = Math.Abs((int)sample);
            if (abs > maxSample) maxSample = abs;
            sumSquares += (long)sample * sample;
        }
        double rms = Math.Sqrt((double)sumSquares / sampleCount);

        return String.Format(
            "Recorded: {0} bytes ({1} samples)\n" +
            "Peak amplitude: {2} / 32768 ({3:F1}%)\n" +
            "RMS level: {4:F0}\n" +
            "Status: {5}",
            recorded, sampleCount,
            maxSample, (maxSample * 100.0 / 32768),
            rms,
            maxSample > 500 ? "AUDIO DETECTED - Mic is working!" :
            maxSample > 50 ? "Very quiet audio - try speaking louder" :
            "SILENT - Mic may be muted or not working"
        );
    }
}
'@

$result = [MicTest]::Test(3000)
Write-Host $result
