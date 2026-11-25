import Foundation
import SwiftData

@Model
final class Recipe {
    var title: String
    var markdown: String
    var category: String
    var device: String
    var isFavorite: Bool
    var createdAt: Date
    var updatedAt: Date

    init(
        title: String,
        markdown: String,
        category: String = RecipeCategory.general.rawValue,
        device: String = CookingDevice.thermomix.rawValue,
        isFavorite: Bool = false,
        createdAt: Date = .now
    ) {
        self.title = title
        self.markdown = markdown
        self.category = category
        self.device = device
        self.isFavorite = isFavorite
        self.createdAt = createdAt
        self.updatedAt = createdAt
    }

    var deviceEnum: CookingDevice {
        CookingDevice.from(raw: device)
    }

    var displayTitle: String {
        title.trimmingCharacters(in: .whitespaces).isEmpty ? "Ohne Titel" : title
    }

    var blocks: [MarkdownBlock] {
        MarkdownParser.parse(markdown)
    }
}

/// Küchengerät, für das ein Rezept gedacht ist – steuert die KI-Generierung.
enum CookingDevice: String, CaseIterable, Identifiable, Codable, Sendable {
    case free = "Freies Kochen"
    case thermomix = "Thermomix (TM6/TM7)"
    case monsieurCuisine = "Lidl Monsieur Cuisine"

    var id: String { rawValue }

    var shortLabel: String {
        switch self {
        case .free: return "Frei"
        case .thermomix: return "TM6/TM7"
        case .monsieurCuisine: return "Monsieur Cuisine"
        }
    }

    var promptInstruction: String {
        switch self {
        case .free:
            return "Gerät: Freies Kochen (Herd, Topf, Pfanne – kein elektrisches Küchengerät). Formuliere alle Zubereitungsschritte als normale Herd-/Topf-Schritte ohne Gerät."
        case .thermomix:
            return "Gerät: Thermomix TM6/TM7. Formuliere die Zubereitung als TM-Schritte mit Temperatur (°C), Stufe und Zeit (z. B. „3 Min. | 120 °C | Stufe 1“), wie im Skill beschrieben."
        case .monsieurCuisine:
            return "Gerät: Lidl Monsieur Cuisine (Connect). Formuliere die Zubereitung als Monsieur-Cuisine-Schritte mit den Begriffen des Geräts (z. B. „Rühren“, „Dämpfen“, „Kneten“, „Garen“ mit Temperatur, Stufe und Zeit)."
        }
    }

    static func from(raw: String) -> CookingDevice {
        CookingDevice(rawValue: raw) ?? .thermomix
    }
}

enum RecipeCategory: String, CaseIterable, Identifiable {
    case all = "Alle"
    case general = "Allgemein"
    case soup = "Suppen"
    case main = "Hauptgerichte"
    case dessert = "Desserts"
    case baking = "Backen"
    case drinks = "Getränke"

    var id: String { rawValue }
}

enum SeedData {
    static func ensureSeeded(context: ModelContext) {
        let descriptor = FetchDescriptor<Recipe>()
        let count = (try? context.fetch(descriptor).count) ?? 0
        guard count == 0 else { return }
        context.insert(Recipe(
            title: "Cremige Tomatensuppe (TM6)",
            markdown: SampleMarkdown.recipe,
            category: RecipeCategory.soup.rawValue,
            isFavorite: true
        ))
        try? context.save()
    }
}

enum SampleMarkdown {
    static let recipe = """
    # Cremige Tomatensuppe (TM6)

    **Portionen:** 4 | **Arbeitszeit:** 10 Min. | **Gesamtzeit:** 30 Min. | **Schwierigkeit:** Leicht

    ## Zutaten

    - 1 Zwiebel
    - 2 Knoblauchzehen
    - 30 g Olivenöl
    - 800 g stückige Tomaten (Dose)
    - 200 ml Gemüsebrühe
    - 100 ml Sahne
    - 1 TL Zucker
    - Salz, Pfeffer
    - frisches Basilikum

    ---

    ## Zubereitung

    **Schritt 1**
    *Benötigt: 1 Zwiebel, 2 Knoblauchzehen, 30 g Öl*
    Zwiebel und Knoblauch in den Mixtopf geben, **5 Sek. | Stufe 5** zerkleinern, mit dem Spatel nach unten schieben. **3 Min. | 120 °C | Stufe 1** andünsten.

    **Schritt 2**
    *Benötigt: 800 g Tomaten, 200 ml Brühe, 1 TL Zucker*
    Tomaten, Brühe und Zucker zugeben. Gareinsatz statt Messbecher aufsetzen. **15 Min. | 100 °C | Stufe 1** köcheln.

    **Schritt 3**
    *Benötigt: 100 ml Sahne*
    Sahne zugeben und **20 Sek. | Stufe 5–6** pürieren. Mit Salz und Pfeffer abschmecken.

    ---

    Mit frischem Basilikum servieren.
    """
}
