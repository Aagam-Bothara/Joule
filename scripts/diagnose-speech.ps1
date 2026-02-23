Add-Type -AssemblyName System.Speech

Write-Host "=== JARVIS Speech Diagnostic ==="
Write-Host ""

# Check installed recognizers
Write-Host "1. Installed speech recognizers:"
$recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
if ($recognizers.Count -eq 0) {
    Write-Host "   NONE FOUND - Speech recognition language pack not installed!"
    Write-Host "   Fix: Settings > Time & Language > Speech > Add language"
    exit 1
} else {
    foreach ($r in $recognizers) {
        Write-Host ("   - " + $r.Culture.Name + " (" + $r.Description + ")")
    }
}

Write-Host ""

# Check default audio device
Write-Host "2. Testing audio device..."
try {
    $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    $rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $rec.SetInputToDefaultAudioDevice()
    Write-Host "   Default audio device: OK"
} catch {
    Write-Host ("   ERROR: " + $_.Exception.Message)
    Write-Host "   Fix: Check your microphone in Settings > System > Sound > Input"
    exit 1
}

Write-Host ""
Write-Host "3. Listening for 8 seconds - SPEAK ANYTHING NOW..."
Write-Host "   (say 'hello' or 'testing one two three')"
Write-Host ""

$rec.InitialSilenceTimeout = [TimeSpan]::FromSeconds(8)
$rec.EndSilenceTimeout = [TimeSpan]::FromSeconds(2)
$rec.BabbleTimeout = [TimeSpan]::FromSeconds(8)

try {
    $result = $rec.Recognize([TimeSpan]::FromSeconds(8))
    if ($result -ne $null) {
        Write-Host ("   RECOGNIZED: '" + $result.Text + "'")
        Write-Host ("   Confidence: " + $result.Confidence)
        Write-Host ("   SUCCESS - Speech recognition is working!")
    } else {
        Write-Host "   No speech detected."
        Write-Host ""
        Write-Host "   Possible causes:"
        Write-Host "   a) Microphone is muted or volume too low"
        Write-Host "   b) Wrong microphone selected as default"
        Write-Host "   c) Check: Settings > System > Sound > Input"
        Write-Host "   d) Try speaking louder or closer to mic"
    }
} catch {
    Write-Host ("   ERROR: " + $_.Exception.Message)
} finally {
    $rec.Dispose()
}

Write-Host ""

# Also check mic input level using winmm
Write-Host "4. Checking microphone devices (winmm)..."
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class MicInfo {
    [DllImport("winmm.dll")]
    static extern int waveInGetNumDevs();

    [DllImport("winmm.dll", CharSet=CharSet.Auto)]
    static extern int waveInGetDevCaps(int deviceId, ref WAVEINCAPS caps, int size);

    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]
    struct WAVEINCAPS {
        public short wMid;
        public short wPid;
        public int vDriverVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)]
        public string szPname;
        public int dwFormats;
        public short wChannels;
        public short wReserved1;
    }

    public static void ListDevices() {
        int count = waveInGetNumDevs();
        Console.WriteLine("   Found " + count + " device(s):");
        for (int i = 0; i < count; i++) {
            WAVEINCAPS caps = new WAVEINCAPS();
            waveInGetDevCaps(i, ref caps, Marshal.SizeOf(caps));
            Console.WriteLine("   [" + i + "] " + caps.szPname + " (channels: " + caps.wChannels + ")");
        }
    }
}
'@

[MicInfo]::ListDevices()
