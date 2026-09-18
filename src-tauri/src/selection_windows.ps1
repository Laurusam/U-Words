$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
try {
  $element = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $element -or $element.Current.IsPassword) { exit }
  $pattern = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
  $ranges = $pattern.GetSelection()
  if ($ranges.Count -ne 1) { exit }
  $text = $ranges[0].GetText(65536)
  if ([string]::IsNullOrWhiteSpace($text)) { exit }
  $rectangles = $ranges[0].GetBoundingRectangles()
  if ($rectangles.Count -eq 0) { exit }
  $rect = $rectangles[$rectangles.Count - 1]
  $editable = -not $ranges[0].GetAttributeValue([System.Windows.Automation.TextPattern]::IsReadOnlyAttribute)
  $prefix = $pattern.DocumentRange.Clone()
  $prefix.MoveEndpointByRange([System.Windows.Automation.TextPatternRangeEndpoint]::End,$ranges[0],[System.Windows.Automation.TextPatternRangeEndpoint]::Start)
  $offset = $prefix.GetText(-1).Length
  @{text=$text;pid=$element.Current.ProcessId;key=(($element.GetRuntimeId() -join ':') + ':' + $offset + ':' + $text.Length);x=$rect.X;y=$rect.Y;width=$rect.Width;height=$rect.Height;editable=$editable} | ConvertTo-Json -Compress
} catch { }
