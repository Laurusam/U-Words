import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Pixel-clean production rendering of the generated U-wave concept.
// Usage: swift scripts/make-wave-icon.swift src-tauri/icons/source-u-words.png
guard CommandLine.arguments.count == 2 else {
    fputs("Usage: make-wave-icon.swift output.png\n", stderr)
    exit(2)
}

let side = 1024
let size = CGFloat(side)
guard let context = CGContext(
    data: nil,
    width: side,
    height: side,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fputs("Cannot create image context\n", stderr)
    exit(1)
}

context.setAllowsAntialiasing(true)
context.setShouldAntialias(true)
context.clear(CGRect(x: 0, y: 0, width: size, height: size))

let tile = CGRect(x: 48, y: 48, width: 928, height: 928)
context.addPath(CGPath(roundedRect: tile, cornerWidth: 222, cornerHeight: 222, transform: nil))
context.setFillColor(CGColor(gray: 1, alpha: 1))
context.fillPath()

// All bar bottoms share an exact baseline. Left and right rise; the center
// is lowest. Fifteen narrow capsules give the mark a denser, finer rhythm.
let heights: [CGFloat] = [525, 500, 450, 390, 320, 255, 205, 180, 205, 255, 320, 390, 450, 500, 525]
let barWidth: CGFloat = 31
let gap: CGFloat = 22
let totalWidth = CGFloat(heights.count) * barWidth + CGFloat(heights.count - 1) * gap
let firstX = (size - totalWidth) / 2
let baseline: CGFloat = 258
context.setFillColor(CGColor(gray: 0, alpha: 1))
for (index, height) in heights.enumerated() {
    let rect = CGRect(x: firstX + CGFloat(index) * (barWidth + gap), y: baseline, width: barWidth, height: height)
    context.addPath(CGPath(roundedRect: rect, cornerWidth: barWidth / 2, cornerHeight: barWidth / 2, transform: nil))
    context.fillPath()
}

let outputURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fputs("Cannot create PNG destination\n", stderr)
    exit(1)
}
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else {
    fputs("Cannot save PNG\n", stderr)
    exit(1)
}
