import SwiftUI
import SwiftData

struct EditRecipeView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss

    @Bindable var recipe: Recipe

    @State private var title = ""
    @State private var category: RecipeCategory = .general
    @State private var markdown = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Titel") {
                    TextField("Titel", text: $title)
                }
                Section("Kategorie") {
                    Picker("Kategorie", selection: $category) {
                        ForEach(RecipeCategory.allCases.filter { $0 != .all }) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.inline)
                }
                Section("Rezept (Markdown)") {
                    TextEditor(text: $markdown)
                        .frame(minHeight: 320)
                        .font(.system(.body, design: .monospaced))
                }
            }
            .navigationTitle("Rezept bearbeiten")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sichern") { save() }
                }
            }
            .onAppear {
                title = recipe.title
                markdown = recipe.markdown
                category = RecipeCategory(rawValue: recipe.category) ?? .general
            }
        }
    }

    private func save() {
        recipe.title = title.trimmingCharacters(in: .whitespaces)
        recipe.markdown = markdown
        recipe.category = category.rawValue
        recipe.updatedAt = .now
        try? modelContext.save()
        dismiss()
    }
}
