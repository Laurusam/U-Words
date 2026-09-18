$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System.Runtime.InteropServices;
public class UWordsDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr context); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
'@
try { if (-not [UWordsDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))) {[UWordsDpi]::SetProcessDPIAware() | Out-Null} } catch {[UWordsDpi]::SetProcessDPIAware() | Out-Null}
$area = [System.Windows.Forms.SystemInformation]::VirtualScreen
$screen = [System.Drawing.Bitmap]::new($area.Width,$area.Height)
$graphics = [System.Drawing.Graphics]::FromImage($screen)
$graphics.CopyFromScreen($area.Left,$area.Top,0,0,$area.Size)
$graphics.Dispose()
$form = [System.Windows.Forms.Form]::new()
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Bounds = $area
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.KeyPreview = $true
$form.Cursor = [System.Windows.Forms.Cursors]::Cross
$form.BackgroundImage = $screen
$script:start = $null
$script:selection = [System.Drawing.Rectangle]::Empty
$form.add_KeyDown({if ($_.KeyCode -eq 'Escape') { $form.Close() }})
$form.add_MouseDown({if ($_.Button -eq 'Left') {$script:start = $_.Location}})
$form.add_MouseMove({if ($null -ne $script:start) {
  $script:selection = [System.Drawing.Rectangle]::FromLTRB([Math]::Min($script:start.X,$_.X),[Math]::Min($script:start.Y,$_.Y),[Math]::Max($script:start.X,$_.X),[Math]::Max($script:start.Y,$_.Y))
  $form.Invalidate()
}})
$form.add_Paint({if ($script:selection.Width -gt 0) {$_.Graphics.DrawRectangle([System.Drawing.Pens]::White,$script:selection)}})
$form.add_MouseUp({if ($_.Button -eq 'Left' -and $script:selection.Width -gt 4 -and $script:selection.Height -gt 4) {
  $crop = $screen.Clone($script:selection,$screen.PixelFormat)
  $crop.Save($env:UWORDS_CAPTURE_PATH,[System.Drawing.Imaging.ImageFormat]::Png)
  $crop.Dispose()
  $form.Close()
}})
$form.ShowDialog() | Out-Null
$screen.Dispose()
$form.Dispose()
