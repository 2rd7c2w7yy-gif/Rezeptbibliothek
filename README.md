# RezeptBibliothek

Eine native SwiftUI-App für **Mac (MacBook), iPhone und iPad** (ein gemeinsamer Code, Multiplatform-Target), mit der du Rezepte **mit deiner Mistral-KI erstellen** und in einer **Bibliothek verwalten** kannst. Jedes Rezept lässt sich als **druckoptimiertes PDF (DIN A4, max. 2 Seiten)** exportieren.

Die KI nutzt dabei **deinen eigenen Skill `rezepte-thermomix`** aus dem Mistral Studio: Die App lädt den Skill zur Laufzeit über die Mistral API (`GET /v2/skills/skill:rezepte-thermomix?alias=main`) und verwendet ihn als System-Prompt für die Chat Completion (`POST /v1/chat/completions`). Ist das Studio nicht erreichbar, fällt die App auf eine im App-Bundle eingebettete Kopie des Skills zurück (`RezeptBibliothek/Resources/FallbackSkill.md`).

## Web-App (GitHub Pages, nur GitHub – kein Supabase) – oeffentlich lesbar, nur Besitzer schreibt

Im Ordner `docs/` liegt die statische Web-App (plain HTML/CSS/JS). **Lesen ist oeffentlich – kein Login, kein GitHub-Konto fuer Besucher.** Die Bibliothek liegt in einem **oeffentlichen GitHub-Repo** `rezeptbibliothek-bibliothek` (wird beim ersten Besitzer-Login automatisch angelegt). **Nur der Besitzer** meldet sich mit seinem **GitHub-Token** an (Button „Besitzer-Login“) und kann Rezepte per KI erstellen/ueberarbeiten/loeschen sowie Gruppen anlegen. Alle anderen sehen die Bibliothek schreibgeschuetzt (suchen, filtern, Favoriten lokal, PDF-Druck).

- **Besitzer-Login**: GitHub classic Token, Scope `repo` (github.com/settings/tokens → Tokens (classic) → „Generate new token (classic)“; alternativ Token ueber die gh-CLI im Terminal erzeugen und mit `gh auth token`-Pendant auslesen). Token bleibt lokal im Browser (localStorage), wird nur an api.github.com gesendet.
- **Schreibschutz**: Schreiben geht nur ueber die GitHub-Contents-API mit dem Token des Repo-Owners – serverseitig erzwungen (oeffentliches Repo, nur Owner hat Schreibrechte). Die App blendet Besitzer-Funktionen ohne Login aus.
- **KI (Mistral)**: nur Besitzer; Key lokal im Browser (localStorage), nur an api.mistral.ai. Skill `rezepte-thermomix` live aus dem Studio, Fallback `docs/fallback-skill.md`.
- **Foto-Rezept (Vision)**: Besitzer-only, Button „📷 Foto-Rezept“ – 1–2 Fotos hochladen oder mit der Kamera aufnehmen (mobil), optionaler Zusatzwunsch + Geräte-Schalter; Mistral-Vision erstellt daraus ein Rezept (Auto-Save). Modelle: mistral-large-latest, Fallback pixtral-12b-2409.
- **Rezept als Text kopieren**: Rezeptansicht → „📋 Text kopieren“ → kompletter Rezepttext in die Zwischenablage. Zum Übertragen z. B. nach Cookidoo („Meine Kreationen“ → „+“ → „Neues Rezept“/KI) oder in offene Tools (MCS Recipe Importer für Lidl Monsieur Cuisine) einfach einfügen.
- **Gruppen**: `groups.json` + `group`-Feld im Rezept (Front Matter), alles im oeffentlichen Library-Repo.

**Aktivierung**: Repo → Settings → Pages → Branch `vibe/rezeptbibliothek-app-e0d4f7`, Folder `/docs` → Save. URL: `https://<github-user>.github.io/Rezeptbibliothek/`.

## Funktionen

- **Rezepte mit KI erstellen**: Wunsch in Freitext eingeben (z. B. „vegane Linsensuppe für 4 Personen, scharf, in 30 Minuten“) → der Skill `rezepte-thermomix` erzeugt ein TM6-Rezept als Markdown → Vorschau, speichern, PDF exportieren.
- **KI-Fenster zentriert, nie Vollbild**: Das Fenster „Rezept mit KI“ ist ein eigenes `Window` mit `.defaultPosition(.center)` und `.windowResizability(.contentSize)` – es öffnet sich mittig auf dem Bildschirm und nicht im Vollbildmodus.
- **Rezept per KI überarbeiten**: Im KI-Fenster gibt es den Abschnitt „Weiter überarbeiten (KI)“ für weitere Änderungswünsche (z. B. „weniger scharf“); zusätzlich öffnet „Mit KI überarbeiten“ in der Rezeptansicht das Fenster mit dem aktuellen Rezept – „Rezept aktualisieren“ überschreibt es direkt.
- **Geräte-Schalter**: Freies Kochen, Thermomix (TM6/TM7) oder Lidl Monsieur Cuisine – wählbar im KI-Fenster (segmentiert) und in den Einstellungen. Die KI formuliert das Rezept passend zum Gerät; das gewählte Gerät wird am Rezept gespeichert und in der Detailansicht angezeigt.
- **Bibliothek**: Alle Rezepte mit Suche, Kategorie-Filter, Sortierung (Datum, Name, Favoriten) und Favoriten-Stern. Bearbeiten und Löschen direkt in der App.
- **PDF-Export**: Jedes Rezept wird als DIN-A4-PDF (max. 2 Seiten, wie im Skill vorgesehen) erzeugt – auf dem iPhone/iPad über das Teilen-Menü (Dateien, AirDrop, Mail …), auf dem Mac zusätzlich über „Sichern unter …“.
- **Dein Skill**: Wird live aus deinem Mistral Studio geladen (Name/Alias in den Einstellungen anpassbar, Standard: `rezepte-thermomix`, Alias `main`), inklusive Versionsanzeige. Änderungen am Skill in Studio wirken sich sofort aus, ohne App-Update.
- **Sicherheit**: Dein Mistral-API-Key wird nur lokal im Schlüsselbund (Keychain) des Geräts gespeichert und direkt an `api.mistral.ai` gesendet.

## Voraussetzungen

- Mac mit **Xcode 15 oder neuer**
- **macOS 14 (Sonoma) oder neuer** auf dem MacBook, **iOS/iPadOS 17 oder neuer** auf iPhone/iPad
- Einen **Mistral-API-Key** (kostenlos erstellen in der [Mistral Console](https://console.mistral.ai) unter „API Keys“; der Key muss Zugriff auf deinen Workspace haben, in dem der Skill liegt)
- Zum Installieren auf iPhone/iPad: Mac und iPhone/iPad mit derselben Apple-ID, in Xcode als „Run Destination“ das Gerät auswählen (ggf. „Vertrauen“ auf dem Gerät bestätigen)

## Einrichtung

1. Repository klonen und `RezeptBibliothek.xcodeproj` in Xcode öffnen.
2. Target `RezeptBibliothek` auswählen → Reiter **Signing & Capabilities** → eigenes Team auswählen (oder „Sign to Run Locally“). **Bundle Identifier** bei Bedarf anpassen (aktuell `de.dimadabemi.rezeptbibliothek`).
3. App starten (Mac: ▶️; iPhone/iPad: Gerät als Ziel wählen und starten).
4. In der App unter **Einstellungen** (Zahnrad) deinen Mistral-API-Key eintragen und speichern. Unter „Skill abrufen & testen“ prüfen, ob `rezepte-thermomix` geladen wird (zeigt die Version aus dem Studio an).
5. Über das **✨ Sparkles**-Symbol ein erstes Rezept generieren.

## Rezepte als PDF

In der Rezeptansicht auf **„PDF exportieren“** klicken. Die App rendert das Markdown-Rezept druckoptimiert auf DIN A4 (max. 2 Seiten, passend zum Layout des Skills) und legt die PDF-Datei an:

- **iPhone/iPad**: „PDF teilen“ → Ablage in Dateien, AirDrop, Mail, Drucken usw.
- **Mac**: „PDF sichern unter …“ (Speicherort frei wählbar) oder „PDF teilen“.

## Synchronisation zwischen Mac, iPhone und iPad (optional, iCloud)

Standardmäßig speichert die App lokal (SwiftData). Für eine gemeinsame Bibliothek über iCloud:

1. In Xcode: Target → **Signing & Capabilities** → **+ Capability** → **CloudKit** hinzufügen (Container `iCloud.<Bundle-ID>` wird automatisch angelegt).
2. In `RezeptBibliothekApp.swift` die Zeile `ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)` ersetzen durch `ModelConfiguration(schema: schema, cloudKitDatabase: .automatic)`.
3. Auf allen Geräten mit derselben Apple-ID anmelden. Die Bibliothek synchronisiert dann über iCloud.

## Projektstruktur

```
RezeptBibliothek/
├── RezeptBibliothek.xcodeproj/          # Xcode-Projekt (Multiplatform: macOS + iOS/iPadOS)
└── RezeptBibliothek/
    ├── RezeptBibliothekApp.swift         # App-Einstieg, SwiftData-Container
    ├── Info.plist
    ├── Models/Recipe.swift               # SwiftData-Modell + Kategorien + Beispiel-Rezept
    ├── Services/
    │   ├── MistralAIService.swift        # Skill-API (/v2/skills) + Chat Completions (/v1/chat/completions)
    │   ├── SkillProvider.swift           # Skill laden (Studio → Fallback) + System-Prompt bauen
    │   ├── KeychainService.swift         # API-Key sicher im Schlüsselbund
    │   └── PDFExportService.swift        # DIN-A4-PDF (max. 2 Seiten) via ImageRenderer + CoreGraphics
    ├── Utilities/Markdown.swift          # kleiner Markdown-Renderer (Überschriften, Listen, Fett/Kursiv)
    ├── Views/
    │   ├── ContentView.swift             # NavigationSplitView (Sidebar + Detail)
    │   ├── SidebarView.swift             # Bibliothek: Suche, Filter, Sortierung, Löschen
    │   ├── RecipeDetailView.swift        # Rezeptansicht, Favorit, Bearbeiten, PDF, Löschen
    │   ├── AIRecipeGeneratorView.swift   # KI-Rezeptgenerierung mit Skill
    │   ├── EditRecipeView.swift          # Rezept manuell bearbeiten (Markdown)
    │   └── SettingsView.swift            # API-Key, Modell, Skill-Name/Alias
    └── Resources/FallbackSkill.md        # eingebettete Kopie deines Skills (Offline-Fallback)
```

## Datenschutz

- Der API-Key verlässt das Gerät nur in Richtung `api.mistral.ai` und liegt im Schlüsselbund des Geräts.
- Rezeptwünsche und Rezeptinhalte werden zur Generierung an die Mistral API gesendet (siehe Mistral Datenschutzhinweise). Lokal bleiben sie in der SwiftData-Datenbank des Geräts (bzw. in deinem iCloud-Container, wenn CloudKit aktiviert ist).

## Hinweise zur KI-Nutzung

- Modell und Skill sind in den Einstellungen konfigurierbar (Standard-Modell: `mistral-large-latest`).
- Der Skill wird mit Alias `main` geladen – so kannst du in Studio neue Versionen testen und über den Alias freigeben, ohne die App zu ändern.
- Der System-Prompt ergänzt den Skill um eine API-spezifische Anweisung („nur das Markdown-Rezept zurückgeben“), damit in der App keine Chat-Einleitung um das Rezept herum entsteht.
- **Store-Migration**: Beim Schema-Wechsel (neue Modell-Felder) legt die App den lokalen SwiftData-Store automatisch neu an (Seed-Beispielrezept inklusive). Hinweis: lokal gespeicherte Rezepte aus älteren App-Versionen werden dabei zurückgesetzt.
