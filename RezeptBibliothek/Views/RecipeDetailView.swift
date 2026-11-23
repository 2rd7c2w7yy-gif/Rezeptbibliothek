import SwiftUI
import SwiftData

struct RecipeDetailView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.openWindow) private var openWindow
    @Environment(GeneratorState.self) private var genState
    @Bindable var recipe: Recipe

    @State private var showEdit = false
    @State private var showDeleteConfirm = false
    @State private var pdfURL: URL?
    @State private var exportError: String?

    var body: some View {
        ScrollView {
            MarkdownContentView(markdown: recipe.markdown)
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(recipe.displayTitle)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItemGroup {
                Button {
                    recipe.isFavorite.toggle()
                } label: {
                    Image(systemName: recipe.isFavorite ? "star.fill" : "star")
                        .foregroundStyle(.yellow)
                }
                Button {
                    genState.existingRecipe = recipe
                    genState.existingMarkdown = recipe.markdown
                    genState.existingTitle = recipe.title
                    openWindow(id: "ai-generator")
                } label: {
                    Label("Mit KI überarbeiten", systemImage: "wand.and.stars")
                }
                Button {
                    showEdit = true
                } label: {
                    Label("Bearbeiten", systemImage: "pencil")
                }
                Button {
                    exportPDF()
                } label: {
                    Label("PDF exportieren", systemImage: "square.and.arrow.up")
                }
                if let url = pdfURL {
                    ShareLink(item: url) {
                        Label("PDF teilen", systemImage: "doc.richtext")
                    }
                }
                #if os(macOS)
                if let url = pdfURL {
                    Button {
                        PDFExportService.presentSavePanel(for: url)
                    } label: {
                        Label("PDF sichern unter …", systemImage: "tray.and.arrow.down")
                    }
                }
                #endif
                Button(role: .destructive) {
                    showDeleteConfirm = true
                } label: {
                    Label("Löschen", systemImage: "trash")
                }
            }
        }
        .sheet(isPresented: $showEdit) {
            EditRecipeView(recipe: recipe)
        }
        .confirmationDialog(
            "„\(recipe.displayTitle)“ wirklich löschen?",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Löschen", role: .destructive) {
                modelContext.delete(recipe)
                try? modelContext.save()
            }
        }
        .alert(
            "PDF-Export fehlgeschlagen",
            isPresented: .constant(exportError != nil)
        ) {
            Button("OK") { exportError = nil }
        } message: {
            Text(exportError ?? "")
        }
    }

    @MainActor
    private func exportPDF() {
        do {
            pdfURL = try PDFExportService.exportPDF(for: recipe)
        } catch {
            exportError = error.localizedDescription
        }
    }
}
