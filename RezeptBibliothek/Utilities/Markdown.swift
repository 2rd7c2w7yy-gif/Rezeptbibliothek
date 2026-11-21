import SwiftUI

// MARK: - Block-Parser

enum MarkdownBlock {
    case heading(level: Int, text: String)
    case paragraph(text: String)
    case bullet(text: String)
    case ordered(number: String, text: String)
    case rule
}

enum MarkdownParser {
    static func parse(_ markdown: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            blocks.append(.paragraph(text: paragraph.joined(separator: " ")))
            paragraph.removeAll()
        }

        for raw in markdown.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty {
                flushParagraph()
                continue
            }
            if let (level, text) = heading(line) {
                flushParagraph()
                blocks.append(.heading(level: level, text: text))
                continue
            }
            if isRule(line) {
                flushParagraph()
                blocks.append(.rule)
                continue
            }
            if let text = bullet(line) {
                flushParagraph()
                blocks.append(.bullet(text: text))
                continue
            }
            if let (number, text) = ordered(line) {
                flushParagraph()
                blocks.append(.ordered(number: number, text: text))
                continue
            }
            paragraph.append(line)
        }
        flushParagraph()
        return blocks
    }

    private static func heading(_ line: String) -> (Int, String)? {
        var level = 0
        var rest = Substring(line)
        while rest.hasPrefix("#") {
            level += 1
            rest = rest.dropFirst()
        }
        guard level >= 1, level <= 6, rest.hasPrefix(" ") else { return nil }
        return (level, String(rest).trimmingCharacters(in: .whitespaces))
    }

    private static func isRule(_ line: String) -> Bool {
        let compact = line.replacingOccurrences(of: " ", with: "")
        guard compact.count >= 3, let first = compact.first else { return false }
        guard first == "-" || first == "*" || first == "_" else { return false }
        return compact.allSatisfy { $0 == first }
    }

    private static func bullet(_ line: String) -> String? {
        guard line.count > 2 else { return nil }
        let prefix = String(line.prefix(2))
        if prefix == "- " || prefix == "* " || prefix == "+ " {
            return String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)
        }
        return nil
    }

    private static func ordered(_ line: String) -> (String, String)? {
        guard let separator = line.firstIndex(where: { $0 == "." || $0 == ")" }),
              separator != line.startIndex else { return nil }
        let number = String(line[line.startIndex..<separator])
        guard !number.isEmpty, number.count <= 3, number.allSatisfy({ $0.isNumber }) else { return nil }
        let rest = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
        guard !rest.isEmpty else { return nil }
        return (number, rest)
    }
}

// MARK: - Inline-Formatierung (bold, kursiv, code)

struct InlineSpan {
    let text: String
    let bold: Bool
    let italic: Bool
    let code: Bool
}

enum InlineParser {
    private static let pattern = #"\*\*(.+?)\*\*|`([^`]+)`|\*(?!\s)(.+?)\*"#

    static func parse(_ text: String) -> [InlineSpan] {
        var spans: [InlineSpan] = []
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [.plain(text)] }
        let ns = text as NSString
        let matches = regex.matches(in: text, range: NSRange(location: 0, length: ns.length))
        var cursor = 0
        for match in matches {
            if match.range.location > cursor {
                spans.append(.plain(ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))))
            }
            if match.range(at: 1).location != NSNotFound {
                spans.append(InlineSpan(text: ns.substring(with: match.range(at: 1)), bold: true, italic: false, code: false))
            } else if match.range(at: 2).location != NSNotFound {
                spans.append(InlineSpan(text: ns.substring(with: match.range(at: 2)), bold: false, italic: false, code: true))
            } else if match.range(at: 3).location != NSNotFound {
                spans.append(InlineSpan(text: ns.substring(with: match.range(at: 3)), bold: false, italic: true, code: false))
            }
            cursor = match.range.location + match.range.length
        }
        if cursor < ns.length {
            spans.append(.plain(ns.substring(with: NSRange(location: cursor, length: ns.length - cursor))))
        }
        return spans
    }
}

extension InlineSpan {
    static func plain(_ text: String) -> InlineSpan {
        InlineSpan(text: text, bold: false, italic: false, code: false)
    }
}

// MARK: - SwiftUI-Ansicht

struct MarkdownContentView: View {
    let markdown: String
    var compact: Bool = false

    var body: some View {
        let blocks = MarkdownParser.parse(markdown)
        VStack(alignment: .leading, spacing: compact ? 5 : 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            InlineText(text: text)
                .font(level == 1 ? .title.bold() : level == 2 ? .title2.bold() : .headline.bold())
                .padding(.top, compact ? 2 : 6)
        case .paragraph(let text):
            InlineText(text: text)
        case .bullet(let text):
            HStack(alignment: .top, spacing: 6) {
                Text("•")
                InlineText(text: text)
            }
        case .ordered(let number, let text):
            HStack(alignment: .top, spacing: 6) {
                Text("\(number).")
                    .frame(minWidth: 22, alignment: .trailing)
                InlineText(text: text)
            }
        case .rule:
            Divider()
        }
    }
}

struct InlineText: View {
    let text: String

    var body: some View {
        let spans = InlineParser.parse(text.replacingOccurrences(of: "\\*", with: "*"))
        var rendered = Text("")
        for span in spans {
            var part = Text(span.text)
            if span.bold { part = part.bold() }
            if span.italic { part = part.italic() }
            if span.code { part = part.font(.system(.body, design: .monospaced)) }
            rendered = rendered + part
        }
        return rendered
    }
}
