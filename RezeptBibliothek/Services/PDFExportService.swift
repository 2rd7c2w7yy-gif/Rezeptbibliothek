import SwiftUI
import CoreGraphics
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
import UniformTypeIdentifiers
#endif

/// Erzeugt aus einem Rezept ein druckoptimiertes PDF (DIN A4, max. 2 Seiten),
/// so wie es der Skill vorsieht.
enum PDFExportService {
    static let pageSize = CGSize(width: 595.2, height: 841.8) // DIN A4 in Punkten (72 dpi)
    static let margin: CGFloat = 50
    static let maxPages = 2

    enum PDFError: LocalizedError {
        case contextCreation
        case writeFailed

        var errorDescription: String? {
            switch self {
            case .contextCreation: return "PDF-Kontext konnte nicht erstellt werden."
            case .writeFailed: return "PDF-Datei konnte nicht geschrieben werden."
            }
        }
    }

    static func exportPDF(for recipe: Recipe) throws -> URL {
        let contentWidth = pageSize.width - 2 * margin
        let renderer = ImageRenderer(
            content:
                RecipePrintView(recipe: recipe)
                .frame(width: contentWidth)
                .background(Color.white)
        )
        renderer.isOpaque = true
        renderer.scale = 2

        let data = NSMutableData()
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let context = CGContext(consumer: consumer, mediaBox: nil) else {
            throw PDFError.contextCreation
        }

        let pageRect = CGRect(origin: .zero, size: pageSize)
        let contentHeight = pageSize.height - 2 * margin

        renderer.render { _, draw in
            for page in 0..<maxPages {
                context.beginPage(mediaBox: pageRect)
                context.saveGState()
                // Ursprung oben links, y-Achse nach unten (wie SwiftUI)
                context.translateBy(x: margin, y: pageSize.height - margin)
                context.scaleBy(x: 1, y: -1)
                // Seitenumbruch: Inhalt um eine Seite nach oben verschieben
                context.translateBy(x: 0, y: -CGFloat(page) * contentHeight)
                draw(context)
                context.restoreGState()
                context.endPage()
            }
        }

        let fileName = recipe.displayTitle
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
            + ".pdf"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            throw PDFError.writeFailed
        }
        return url
    }

    #if os(macOS)
    static func presentSavePanel(for url: URL) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = url.lastPathComponent
        panel.allowedContentTypes = [.pdf]
        panel.begin { result in
            guard result == .OK, let destination = panel.url else { return }
            try? FileManager.default.removeItem(at: destination)
            try? FileManager.default.copyItem(at: url, to: destination)
        }
    }
    #endif
}

struct RecipePrintView: View {
    let recipe: Recipe

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            MarkdownContentView(markdown: recipe.markdown, compact: true)
            Spacer(minLength: 12)
            Divider()
            Text("Erstellt am \(recipe.createdAt.formatted(date: .abbreviated, time: .omitted)) · RezeptBibliothek")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
