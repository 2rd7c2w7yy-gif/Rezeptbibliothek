import SwiftUI
import SwiftData

struct SidebarView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.openWindow) private var openWindow
    @Environment(GeneratorState.self) private var genState
    @Query(sort: \Recipe.createdAt, order: .reverse) private var recipes: [Recipe]

    @Binding var selection: Recipe?

    @State private var searchText = ""
    @State private var category: RecipeCategory = .all
    @State private var favoritesOnly = false
    @State private var sort: SortOrder = .newest
    @State private var showSettings = false

    enum SortOrder: String, CaseIterable, Identifiable {
        case newest = "Neueste zuerst"
        case oldest = "Älteste zuerst"
        case title = "Name A–Z"
        case favorites = "Favoriten zuerst"

        var id: String { rawValue }
    }

    var filtered: [Recipe] {
        var list = recipes
        if favoritesOnly {
            list = list.filter { $0.isFavorite }
        }
        if category != .all {
            list = list.filter { $0.category == category.rawValue }
        }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !query.isEmpty {
            list = list.filter {
                $0.title.lowercased().contains(query) || $0.markdown.lowercased().contains(query)
            }
        }
        switch sort {
        case .newest:
            list.sort { $0.createdAt > $1.createdAt }
        case .oldest:
            list.sort { $0.createdAt < $1.createdAt }
        case .title:
            list.sort { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        case .favorites:
            list.sort {
                if $0.isFavorite != $1.isFavorite { return $0.isFavorite }
                return $0.createdAt > $1.createdAt
            }
        }
        return list
    }

    var body: some View {
        List(selection: $selection) {
            ForEach(filtered) { recipe in
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(recipe.displayTitle)
                            .font(.headline)
                        Text(recipe.category)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: recipe.isFavorite ? "star.fill" : "doc.text")
                        .foregroundStyle(recipe.isFavorite ? .yellow : .secondary)
                }
                .tag(recipe)
            }
            .onDelete(perform: delete)
        }
        .searchable(text: $searchText, prompt: "Rezepte durchsuchen")
        .navigationTitle("Bibliothek")
        .toolbar {
            ToolbarItemGroup {
                Menu {
                    Picker("Kategorie", selection: $category) {
                        ForEach(RecipeCategory.allCases) { Text($0.rawValue).tag($0) }
                    }
                    Toggle("Nur Favoriten", isOn: $favoritesOnly)
                    Picker("Sortierung", selection: $sort) {
                        ForEach(SortOrder.allCases) { Text($0.rawValue).tag($0) }
                    }
                } label: {
                    Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
                }
                Button {
                    showSettings = true
                } label: {
                    Label("Einstellungen", systemImage: "gearshape")
                }
                Button {
                    genState.reset()
                    openWindow(id: "ai-generator")
                } label: {
                    Label("Neues Rezept mit KI", systemImage: "sparkles")
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
    }

    private func delete(_ offsets: IndexSet) {
        for index in offsets {
            modelContext.delete(filtered[index])
        }
        try? modelContext.save()
        if let selected = selection, !filtered.contains(selected) {
            selection = nil
        }
    }
}
