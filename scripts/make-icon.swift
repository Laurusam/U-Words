import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Keeps the generated brush lettering intact while drawing a pixel-clean,
// monochrome rounded tile. Usage: swift scripts/make-icon.swift input.png output.png
guard CommandLine.arguments.count == 3 else {
    fputs("Usage: make-icon.swift input.png output.png\n", stderr)
    exit(2)
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
guard let source = CGImageSourceCreateWithURL(inputURL as CFURL, nil),
      let mark = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fputs("Cannot read source PNG\n", stderr)
    exit(1)
}

let side = max(mark.width, mark.height)
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

let size = CGFloat(side)
let tileInset = size * 0.055
let tile = CGRect(x: tileInset, y: tileInset, width: size - tileInset * 2, height: size - tileInset * 2)
let corner = tile.width * 0.22
context.clear(CGRect(x: 0, y: 0, width: size, height: size))
context.addPath(CGPath(roundedRect: tile, cornerWidth: corner, cornerHeight: corner, transform: nil))
context.setFillColor(CGColor(gray: 1, alpha: 1))
context.fillPath()

let markInset = size * 0.075
context.interpolationQuality = .high
context.draw(mark, in: CGRect(x: markInset, y: markInset, width: size - markInset * 2, height: size - markInset * 2))

guard let image = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fputs("Cannot create output PNG\n", stderr)
    exit(1)
}
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else {
    fputs("Cannot save output PNG\n", stderr)
    exit(1)
}
