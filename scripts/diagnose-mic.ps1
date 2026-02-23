Add-Type -AssemblyName System.Speech

Write-Host "=== Microphone Level Test ==="
Write-Host "Speak into your mic for 5 seconds..."
Write-Host ""

$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$rec.SetInputToDefaultAudioDevice()

# Register audio level event
$maxLevel = 0
$handler = {
    param($sender, $e)
    $level = $e.AudioLevel
    if ($level -gt $script:maxLevel) { $script:maxLevel = $level }
    $bar = "#" * ($level / 3)
    Write-Host ("`r  Level: " + $level.ToString().PadLeft(3) + " " + $bar.PadRight(30)) -NoNewline
}

$rec.add_AudioLevelUpdated($handler)
$rec.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)

Start-Sleep -Seconds 5

$rec.RecognizeAsyncStop()
$rec.Dispose()

Write-Host ""
Write-Host ""
Write-Host ("Max audio level detected: " + $maxLevel)

if ($maxLevel -eq 0) {
    Write-Host "PROBLEM: Mic is completely silent (level 0)"
    Write-Host "  -> Check Windows Settings > System > Sound > Input"
    Write-Host "  -> Make sure your microphone is not muted"
    Write-Host "  -> Make sure the correct mic is selected"
} elseif ($maxLevel -lt 10) {
    Write-Host "WARNING: Very low mic volume. Turn up your mic gain."
} else {
    Write-Host "Mic is working! Audio levels look good."
}
