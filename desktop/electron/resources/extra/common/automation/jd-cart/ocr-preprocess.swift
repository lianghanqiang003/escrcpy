import Foundation
import CoreGraphics
import ImageIO

// Improve white-on-red button text for local OCR. No network or Vision service.
guard CommandLine.arguments.count == 3,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { exit(2) }
let w = image.width, h = image.height
let rgba = UnsafeMutablePointer<UInt8>.allocate(capacity: w * h * 4)
defer { rgba.deallocate() }
guard let context = CGContext(data: rgba, width: w, height: h, bitsPerComponent: 8,
                             bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(3) }
context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
var gray = Data(count: w * h)
gray.withUnsafeMutableBytes { buffer in
    let out = buffer.bindMemory(to: UInt8.self)
    for i in 0..<(w * h) {
        let p = i * 4
        let luma = (77 * Int(rgba[p]) + 150 * Int(rgba[p + 1]) + 29 * Int(rgba[p + 2])) >> 8
        out[i] = luma > 185 ? 0 : 255
    }
}
guard let provider = CGDataProvider(data: gray as CFData),
      let result = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 8,
                           bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: [],
                           provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[2]) as CFURL,
                                               "public.png" as CFString, 1, nil) else { exit(4) }
CGImageDestinationAddImage(dest, result, nil)
guard CGImageDestinationFinalize(dest) else { exit(5) }
// Isolate solid red/orange call-to-action bars. OCR then reads only their label,
// rather than merging it with surrounding product cards or the Android nav bar.
var segments: [(Int, Int)] = []
var start: Int? = nil
for y in 0..<h {
    var redCount = 0
    for x in 0..<w {
        let p = (y * w + x) * 4
        if rgba[p] > 190 && rgba[p + 1] < 190 && rgba[p + 2] < 150 { redCount += 1 }
    }
    if redCount > w * 16 / 100 {
        if start == nil { start = y }
    } else if let first = start {
        if y - first >= 32 { segments.append((first, y)) }
        start = nil
    }
}
var regions: [[String: Any]] = []
for (index, segment) in segments.prefix(5).enumerated() {
    let (top, bottom) = segment
    var left = w, right = 0
    for y in top..<bottom {
        for x in 0..<w {
            let p = (y * w + x) * 4
            if rgba[p] > 190 && rgba[p + 1] < 190 && rgba[p + 2] < 150 {
                left = min(left, x); right = max(right, x)
            }
        }
    }
    let insetX = max(5, (right-left) / 20), insetY = max(3, (bottom-top) / 10)
    let cropX = left + insetX, cropY = top + insetY
    guard right > left,
          let crop = result.cropping(to: CGRect(x: cropX, y: cropY, width: right-left+1-insetX*2, height: bottom-top-insetY*2)) else { continue }
    let path = CommandLine.arguments[2] + "-\(index).png"
    guard let target = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil) else { continue }
    CGImageDestinationAddImage(target, crop, nil)
    if CGImageDestinationFinalize(target) { regions.append(["path": path, "x": cropX, "y": cropY]) }
}
if let data = try? JSONSerialization.data(withJSONObject: regions) { FileHandle.standardOutput.write(data) }
