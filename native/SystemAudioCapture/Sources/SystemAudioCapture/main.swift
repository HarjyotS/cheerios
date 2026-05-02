import Foundation
import AVFoundation
import CoreMedia
import ScreenCaptureKit
import Darwin

// MARK: - Logging

@inline(__always)
func logErr(_ message: String) {
    let line = "[system-audio-capture] " + message + "\n"
    if let data = line.data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

// MARK: - Args

struct Args {
    var sampleRate: Double = 16000
    var excludeBundleIDs: [String] = []
}

func parseArgs() -> Args {
    var args = Args()
    let argv = CommandLine.arguments
    var i = 1
    while i < argv.count {
        let arg = argv[i]
        switch arg {
        case "--rate":
            if i + 1 < argv.count, let v = Double(argv[i + 1]) {
                args.sampleRate = v
                i += 2
            } else {
                logErr("--rate requires a numeric value")
                exit(2)
            }
        case "--exclude":
            if i + 1 < argv.count {
                args.excludeBundleIDs.append(argv[i + 1])
                i += 2
            } else {
                logErr("--exclude requires a bundle id")
                exit(2)
            }
        case "-h", "--help":
            let usage = """
            Usage: system-audio-capture [--rate 16000] [--exclude <bundleID>]...

            Captures system audio via ScreenCaptureKit and writes
            16-bit little-endian PCM (mono) to stdout.
            """
            FileHandle.standardError.write(Data((usage + "\n").utf8))
            exit(0)
        default:
            logErr("unknown argument: \(arg)")
            exit(2)
        }
    }
    return args
}

// MARK: - Audio converter wrapper

/// Converts incoming audio (whatever format the system gives us) to mono Int16 PCM
/// at the requested sample rate, writing the raw bytes to stdout.
final class AudioPipeline {
    private let outputSampleRate: Double
    private let stdout = FileHandle.standardOutput

    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?
    private var targetFormat: AVAudioFormat?

    private let writeQueue = DispatchQueue(label: "system-audio-capture.write")

    init(outputSampleRate: Double) {
        self.outputSampleRate = outputSampleRate
        let target = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: outputSampleRate,
            channels: 1,
            interleaved: true
        )
        self.targetFormat = target
    }

    /// Build (or rebuild) the converter for a given input format.
    private func ensureConverter(for inputFormat: AVAudioFormat) -> AVAudioConverter? {
        if let existing = converter, let src = sourceFormat, src.isEqual(inputFormat) {
            return existing
        }
        guard let target = targetFormat else { return nil }
        guard let conv = AVAudioConverter(from: inputFormat, to: target) else {
            logErr("failed to create AVAudioConverter from \(inputFormat) to \(target)")
            return nil
        }
        // Down-mix matrix isn't strictly required: AVAudioConverter handles channel
        // count reductions itself. We just leave defaults.
        self.converter = conv
        self.sourceFormat = inputFormat
        return conv
    }

    func handle(sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else {
            return
        }
        var asbd = asbdPtr.pointee

        // Build an AVAudioFormat from the ASBD. ScreenCaptureKit hands us
        // non-interleaved Float32 in practice, but we support whatever it gives us.
        guard let inputFormat = AVAudioFormat(streamDescription: &asbd) else {
            logErr("could not build AVAudioFormat from incoming sample buffer")
            return
        }

        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        if frameCount <= 0 { return }

        guard let inputBuffer = AVAudioPCMBuffer(
            pcmFormat: inputFormat,
            frameCapacity: AVAudioFrameCount(frameCount)
        ) else {
            logErr("failed to allocate input PCM buffer")
            return
        }
        inputBuffer.frameLength = AVAudioFrameCount(frameCount)

        // Copy raw audio data from CMSampleBuffer into the AVAudioPCMBuffer's
        // AudioBufferList. We use the AudioBufferList provided by the buffer itself.
        var blockBuffer: CMBlockBuffer?
        var audioBufferList = AudioBufferList()
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )
        if status != noErr {
            logErr("CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer failed: \(status)")
            return
        }

        // The retrieved AudioBufferList may have multiple buffers (one per channel for
        // non-interleaved). Use UnsafeMutableAudioBufferListPointer to iterate.
        let srcAbl = UnsafeMutableAudioBufferListPointer(&audioBufferList)
        let dstAbl = UnsafeMutableAudioBufferListPointer(inputBuffer.mutableAudioBufferList)
        let count = min(srcAbl.count, dstAbl.count)
        for idx in 0..<count {
            let src = srcAbl[idx]
            var dst = dstAbl[idx]
            let bytes = min(src.mDataByteSize, dst.mDataByteSize)
            if let srcData = src.mData, let dstData = dst.mData, bytes > 0 {
                memcpy(dstData, srcData, Int(bytes))
            }
            dst.mDataByteSize = src.mDataByteSize
            dstAbl[idx] = dst
        }

        guard let conv = ensureConverter(for: inputFormat),
              let target = targetFormat else {
            return
        }

        // Allocate an output buffer roughly sized for the requested rate.
        let ratio = target.sampleRate / inputFormat.sampleRate
        let estOutFrames = AVAudioFrameCount(max(1, Int(Double(frameCount) * ratio) + 1024))
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: estOutFrames) else {
            logErr("failed to allocate output PCM buffer")
            return
        }

        var fed = false
        var convError: NSError?
        let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
            if fed {
                outStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            outStatus.pointee = .haveData
            return inputBuffer
        }

        let result = conv.convert(to: outBuffer, error: &convError, withInputFrom: inputBlock)
        if result == .error {
            if let e = convError {
                logErr("AVAudioConverter error: \(e.localizedDescription)")
            } else {
                logErr("AVAudioConverter error (unknown)")
            }
            return
        }

        let outFrames = Int(outBuffer.frameLength)
        if outFrames == 0 { return }
        guard let int16Channel = outBuffer.int16ChannelData else { return }

        // Mono interleaved => single channel pointer, frames * 2 bytes.
        let byteCount = outFrames * MemoryLayout<Int16>.size
        let data = Data(bytes: int16Channel[0], count: byteCount)

        writeQueue.async { [stdout] in
            do {
                try stdout.write(contentsOf: data)
            } catch {
                // stdout closed (parent went away). Exit cleanly.
                logErr("stdout write failed: \(error.localizedDescription)")
                exit(0)
            }
        }
    }
}

// MARK: - Stream output handler

final class StreamOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    let pipeline: AudioPipeline

    init(pipeline: AudioPipeline) {
        self.pipeline = pipeline
    }

    func stream(_ stream: SCStream,
                didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        switch type {
        case .audio:
            pipeline.handle(sampleBuffer: sampleBuffer)
        case .screen:
            // We requested 2x2 video to satisfy SCStreamConfiguration; ignore frames.
            break
        @unknown default:
            break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        logErr("stream stopped with error: \(error.localizedDescription)")
        exit(1)
    }
}

// MARK: - Capture orchestration

actor Capturer {
    private var stream: SCStream?

    func start(args: Args) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: false
        )

        guard let display = content.displays.first else {
            throw NSError(
                domain: "SystemAudioCapture",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No display found for ScreenCaptureKit"]
            )
        }

        let selfBundleIDs = ["com.harjyot.personal-meeting-os"]
        let allExcludeIDs = Set(selfBundleIDs + args.excludeBundleIDs)
        let excludedApps = content.applications.filter { app in
            allExcludeIDs.contains(app.bundleIdentifier)
        }

        let filter = SCContentFilter(
            display: display,
            excludingApplications: excludedApps,
            exceptingWindows: []
        )

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = Int(args.sampleRate)
        config.channelCount = 1
        // Minimal video: required by SCStreamConfiguration. We never read these frames.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1) // 1 fps is plenty
        config.showsCursor = false
        config.queueDepth = 6

        let pipeline = AudioPipeline(outputSampleRate: args.sampleRate)
        let output = StreamOutput(pipeline: pipeline)

        let stream = SCStream(filter: filter, configuration: config, delegate: output)

        let audioQueue = DispatchQueue(label: "system-audio-capture.audio")
        let videoQueue = DispatchQueue(label: "system-audio-capture.video")

        try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: audioQueue)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: videoQueue)

        try await stream.startCapture()
        self.stream = stream

        // Keep a strong reference to the output so it isn't released while the stream
        // runs. Stash it on self by retaining via closure capture.
        Self.retain(output)

        logErr("capture started: rate=\(Int(args.sampleRate))Hz mono int16, excluding \(allExcludeIDs.sorted())")
    }

    func stop() async {
        if let stream = stream {
            do {
                try await stream.stopCapture()
            } catch {
                logErr("error stopping stream: \(error.localizedDescription)")
            }
        }
        self.stream = nil
    }

    // Static retainer keeps strong refs alive across the actor boundary.
    private static var retained: [AnyObject] = []
    static func retain(_ obj: AnyObject) {
        retained.append(obj)
    }
}

// MARK: - Signal handling

final class SignalRouter {
    static let shared = SignalRouter()

    private var sources: [DispatchSourceSignal] = []

    func install(handler: @escaping () -> Void) {
        let signals: [Int32] = [SIGINT, SIGTERM, SIGHUP, SIGPIPE]
        for sig in signals {
            // Ignore default disposition so the dispatch source can take over.
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler {
                logErr("received signal \(sig), shutting down")
                handler()
            }
            src.resume()
            sources.append(src)
        }
    }
}

// MARK: - Entry point

let args = parseArgs()
let capturer = Capturer()

SignalRouter.shared.install {
    Task {
        await capturer.stop()
        exit(0)
    }
}

Task {
    do {
        try await capturer.start(args: args)
    } catch {
        logErr("failed to start capture: \(error.localizedDescription)")
        exit(1)
    }
}

// Run forever. Signals or stdout-closed conditions will exit the process.
RunLoop.main.run()
