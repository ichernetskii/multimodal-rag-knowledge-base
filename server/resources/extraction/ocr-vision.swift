import Foundation
import Vision
import ImageIO

let arguments = CommandLine.arguments
if arguments.count < 2 { exit(2) }
let url = URL(fileURLWithPath: arguments[1])
let handler = VNImageRequestHandler(url: url, options: [:])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.usesCPUOnly = true
if arguments.count > 2 {
    let languages = arguments[2].split(separator: "+").map { value -> String in
        switch value { case "rus": return "ru-RU"; case "deu": return "de-DE"; case "est": return "et-EE"; default: return "en-US" }
    }
    let supported = try request.supportedRecognitionLanguages()
    request.recognitionLanguages = languages.filter { supported.contains($0) }
}
try handler.perform([request])
let results = (request.results ?? []).compactMap { observation -> [String: Any]? in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    return ["text": candidate.string, "confidence": candidate.confidence, "x": Double(observation.boundingBox.minX), "y": Double(observation.boundingBox.midY)]
}.sorted { a,b in
    let ay = a["y"] as! Double; let by = b["y"] as! Double
    if abs(ay-by) > 0.008 { return ay > by }
    return (a["x"] as! Double) < (b["x"] as! Double)
}
let data = try JSONSerialization.data(withJSONObject: results)
FileHandle.standardOutput.write(data)
