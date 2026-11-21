import SwiftUI
import SwiftData

struct AIRecipeGeneratorView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss

    @AppStorage("aiModel") private var aiModel = MistralAIService.defaultModel
    @AppStorage("skillName") private var skillName = "rezepte-thermomix"
    @AppStorage("skillAlias") private var skillAlias = "main"

    @State private var wish = ""
    @State private var category: RecipeCategory = .general
    @State private var phase: Phase = .idle
    @State private var statusMessage = ""
    @State private var resultMarkdown = ""
    @State private var errorMessage: String?
    @State private var saved = false
    @State private var pdfURL: URL?

    enum Phase {
        case idle
        case loadingSkill
        case generating
        case done
    }

    private var settings: MistralAIService.Settings {
        MistralAIService.Settings(
            apiKey: KeychainService.loadAPIKey() ?? "",
            model: aiModel,
            skillName: skillName,
            skillAlias: skillAlias
        )
    }

    private var extractedTitle: String {
        Self.extractTitle(from: resultMarkdown)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Dein Wunsch an die KI") {
                    TextEditor(text: $wish)
                        .frame(minHeight: 110)
                    Text("z. B. „Eine vegane Linsensuppe für 4 Personen, scharf, in 30 Minuten“")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Picker("Kategorie", selection: $category) {
                        ForEach(RecipeCategory.allCases.filter { $0 != .all }) { Text($0.rawValue).tag($0) }
                    }
                }

                Section {
                    Button {
                        Task { await generate() }
                    } label: {
                        if phase == .loadingSkill || phase == .generating {
                            HStack {
                                ProgressView()
                                Text(statusMessage)
                            }
                        } else {
                            Label("Rezept generieren", systemImage: "sparkles")
                        }
                    }
                    .disabled(wish.trimmingCharacters(in: .whitespaces).isEmpty
                               || phase == .loadingSkill
                               || phase == .generating)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                            .font(.footnote)
                    }
                }

                if phase == .done {
                    Section("Vorschau – \(extractedTitle)") {
                        MarkdownContentView(markdown: resultMarkdown)
                    }
                    Section {
                        Button {
                            save()
                        } label: {
                            Label(saved ? "In der Bibliothek gespeichert" : "In Bibliothek speichern", systemImage: saved ? "checkmark.circle.fill" : "tray.and.arrow.down")
                        }
                        .disabled(saved)

                        Button {
                            exportPDF()
                        } label: {
                            Label("Als PDF exportieren", systemImage: "doc.richtext")
                        }
                        if let url = pdfURL {
                            ShareLink(item: url) {
                                Label("PDF teilen", systemImage: "square.and.arrow.up")
                            }
                        }
                        Button {
                            Task { await generate() }
                        } label: {
                            Label("Erneut generieren", systemImage: "arrow.clockwise")
                        }
                    }
                }
            }
            .navigationTitle("Neues Rezept mit KI")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Schließen") { dismiss() }
                }
            }
        }
    }

    private func generate() async {
        errorMessage = nil
        saved = false
        pdfURL = nil
        resultMarkdown = ""
        phase = .loadingSkill
        statusMessage = "Skill „\(skillName)“ wird aus dem Studio geladen …"
        do {
            let (prompt, source) = try await SkillProvider.systemPrompt(for: settings)
            phase = .generating
            statusMessage = "Rezept wird erstellt … (\(source))"
            resultMarkdown = try await MistralAIService.generateRecipe(
                userWish: wish,
                systemPrompt: prompt,
                settings: settings
            )
            phase = .done
        } catch {
            phase = .idle
            errorMessage = error.localizedDescription
        }
    }

    private func save() {
        let recipe = Recipe(
            title: extractedTitle,
            markdown: resultMarkdown,
            category: category.rawValue
        )
        modelContext.insert(recipe)
        try? modelContext.save()
        saved = true
    }

    private func exportPDF() {
        let draft = Recipe(title: extractedTitle, markdown: resultMarkdown, category: category.rawValue)
        pdfURL = try? PDFExportService.exportPDF(for: draft)
    }

    static func extractTitle(from markdown: String) -> String {
        for raw in markdown.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("# ") {
                let title = String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                if !title.isEmpty { return title }
            }
        }
        for raw in markdown.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
                .replacingOccurrences(of: "#", with: "")
                .trimmingCharacters(in: .whitespaces)
            if !line.isEmpty { return line }
        }
        return "Neues Rezept"
    }
}
