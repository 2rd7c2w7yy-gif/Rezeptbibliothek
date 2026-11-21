import SwiftUI
import SwiftData

struct ContentView: View {
    @State private var selection: Recipe?

    var body: some View {
        NavigationSplitView {
            SidebarView(selection: $selection)
        } detail: {
            if let recipe = selection {
                RecipeDetailView(recipe: recipe)
            } else {
                ContentUnavailableView(
                    "Kein Rezept ausgewählt",
                    systemImage: "book.closed",
                    description: Text("Wähle ein Rezept aus der Bibliothek oder erstelle ein neues mit der KI.")
                )
            }
        }
    }
}
