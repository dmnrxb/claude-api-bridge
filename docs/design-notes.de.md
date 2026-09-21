# Claude Bridge

Ein kleiner Dienst, der ein persönliches Claude-Abo als OpenAI-kompatible
API bereitstellt. Außen die übliche Chat-Schnittstelle, innen ein
Claude-Code-Prozess.

Gedacht für den eigenen Gebrauch: eine Person, ein Abo, kein geteilter Zugang.

## Die Idee

Viele Werkzeuge sprechen das OpenAI-Format. Ein Claude-Abo spricht es nicht,
und an der offiziellen API hat ein Abo-Token kein Kontingent. Was ein Abo
öffnet, ist Claude Code als Prozess auf dem eigenen Rechner.

Die Bridge stellt sich dazwischen: sie nimmt eine ganz normale
OpenAI-Chat-Anfrage entgegen, startet damit Claude Code, und gibt die Antwort
im OpenAI-Format zurück. Für den Aufrufer sieht es aus wie ein Anbieter.

Wichtig: hier wird nichts nachgebaut und nichts umgangen. Der Dienst ruft
Anthropics eigenes Werkzeug mit der eigenen Anmeldung des Nutzers auf.

## Die Schnittstelle

Zwei Endpunkte reichen:

```
POST /v1/chat/completions    Chat, mit und ohne Strom
GET  /v1/models              Modellliste
```

**Die Anfrage.** Aus dem Rumpf werden drei Dinge gelesen:

- `messages` der Gesprächsverlauf
- `model` welches Modell gefahren wird
- die Systemanweisung, also die Nachricht mit `role: "system"`

Der Verlauf wird zu einem einzigen Prompt flachgemacht, mit `Human:` und
`Assistant:` als Trenner. Jeder Aufruf ist damit eine eigene Sitzung, es läuft
kein Gespräch im Hintergrund weiter.

**Die Antwort.** Entweder ein JSON-Block in der üblichen Form
(`choices[0].message.content`, dazu `usage`), oder bei `stream: true` ein
Strom aus Server-Sent-Events mit `delta`-Häppchen und einem abschließenden
`data: [DONE]`.

**Die Modellliste** ist eine feste Liste im Code. Sie fragt Anthropic nicht,
sie sagt nur, was der Dienst durchreicht.

## Der Kern

Je Anfrage wird ein Prozess gestartet:

```
claude -p
       --output-format json            (oder stream-json)
       --model <modell>
       --allowed-tools WebSearch WebFetch
       --disallowed-tools Bash Read Write Edit Glob Grep
       --system-prompt "<systemanweisung>"
```

Beim Strom kommen `--verbose` und `--include-partial-messages` dazu, sonst
gibt Claude Code die Häppchen nicht einzeln heraus, sondern die ganze Antwort
als ein Ereignis.

Der Prompt geht über die Standardeingabe hinein. Die Ausgabe wird gelesen,
ausgepackt und in die OpenAI-Form gebracht. Dazu gehört ein Zeitlimit: wenn
der Prozess nicht antwortet, wird er abgeräumt.

## Das Token

Claude Code braucht eine Anmeldung. Für einen Prozess ohne Bildschirm erzeugt
man sie einmal mit:

```bash
claude setup-token
```

Das Ergebnis geht als `CLAUDE_CODE_OAUTH_TOKEN` in die Umgebung des
gestarteten Prozesses.

Zwei Wege sind möglich:

- **Einfach:** das Token liegt in der Umgebung des Dienstes und gilt für alle
  Aufrufe.
- **Besser:** das Token kommt je Aufruf als `Authorization: Bearer` von außen
  herein und wird nur an den Prozess durchgereicht. Dann hält der Dienst
  selbst keines vor, mehrere Konten gehen nebeneinander, und ein Wechsel
  wirkt ohne Neustart.

Auf macOS liegt die normale Anmeldung im Schlüsselbund und nicht in
`~/.claude`. Den Ordner in einen Container zu hängen bringt also nichts, der
Prozess meldet dann „Not logged in". Deshalb der Weg über das Token.

## Zugang absichern

Der Dienst steht vor einem fremden Kontingent, also darf er nicht offen sein.
Ein eigenes Geheimnis, das der Aufrufer als `x-api-key` mitschickt, genügt.
Ohne gesetztes Geheimnis startet der Dienst am besten gar nicht erst.

Kommen Token und Geheimnis getrennt herein, sind es zwei Kopfzeilen:

```
x-api-key: <geheimnis des dienstes>
Authorization: Bearer <konto-token>
```

## Docker

Der Dienst läuft als Container. Was hineingehört:

- **Node 22** als Basis (`node:22-slim`)
- **Die Claude-Code-CLI**, global installiert und auf eine feste Fassung
  festgenagelt. Ohne Festnagelung ziehen zwei Bauläufe am selben Tag
  womöglich zwei verschiedene Fassungen.
- **git und ripgrep** als Systempakete. Claude Code erwartet sie beim Start,
  auch wenn die Werkzeuge abgeschaltet sind.
- **Ein beschreibbares Zuhause** für den Benutzer, etwa `/home/node/.claude`.
  Claude Code legt dort eine Arbeitsablage an, sonst bricht der erste Aufruf
  mit einem Schreibfehler ab.

Der Dienst selbst braucht keine Pakete: `node:http` und `node:child_process`
reichen, also eine einzige Datei.

Er läuft **nicht als root**. Er hört auf einem Port über 1024, schreibt keine
Datei und installiert nichts nach. Das Image bringt den Benutzer `node`
bereits mit.

Und er steht **in einem eigenen Netz**, erreichbar nur von dem, was ihn
wirklich ruft. Er hält ein Abo-Token, und sein Prompt stammt nicht immer von
einer vertrauenswürdigen Quelle. Kein Port nach außen.

## Werkzeuge: zwei Listen, und beide werden gebraucht

`Bash`, `Read`, `Write`, `Edit`, `Glob` und `Grep` bleiben gesperrt. Wenn im
Prompt fremder Text steht, wäre die Kette sonst kurz: Eingabefeld, Prompt,
`env`, Token, hinaus.

`WebSearch` und `WebFetch` sind offen, sie lesen nur. Dabei reicht es nicht,
sie aus der Verbotsliste zu lassen: im Kopfbetrieb fragt Claude Code sonst
nach Erlaubnis, bekommt keine, und das Modell antwortet, es habe nicht suchen
dürfen. Erst die ausdrückliche Erlaubnisliste macht sie benutzbar.

Die Verbotsliste bleibt trotzdem stehen. Sie ist die stärkere der beiden und
sagt, was auch dann nicht geht, wenn jemand die Erlaubnisliste erweitert.

## Was durchpasst, und was nicht

| | |
|---|---|
| Text hinein, Text heraus | geht |
| `stream` | geht, als Server-Sent-Events |
| Websuche | geht, über Claude Codes eigenes WebSearch |
| `tools` und `functions` | geht nicht, besser mit 400 abweisen |
| `response_format`, Structured Output | geht nicht, besser mit 400 abweisen |
| `max_tokens` | wird gelesen und ignoriert, die CLI kennt die Flagge nicht |

Claude Code hat eigene Werkzeuge und ein eigenes Antwortformat. Ein Rumpf, der
nach Anbieterwerkzeugen oder festem Schema fragt, sollte einen klaren Fehler
bekommen und nicht still etwas anderes.

Weitere Eigenheiten:

- Die Systemanweisung **ersetzt** den Systemprompt von Claude Code, statt ihn
  zu ergänzen. Das nimmt den Coding-Rahmen heraus, den ein Chat nicht braucht.
- Claude Code schickt je Aufruf einen eigenen Systemprompt mit, mehrere
  tausend Token. Wer die Tokenzahlen in Kosten umrechnet, bekommt deshalb
  höhere Werte als bei einem blanken API-Aufruf mit demselben Prompt. Beim
  Abo ist so ein Betrag ohnehin nur ein Anhaltspunkt, keine Rechnung.
- Die Websuche taucht in der Verbrauchszeile nicht auf. Sie ist nicht
  Anthropics Server-Werkzeug, sondern Claude Codes eigenes.

## Bauteile in Kurzform

```
Dockerfile      node:22-slim, git, ripgrep, claude-code (feste Fassung),
                Benutzer node, eigenes HOME
server.mjs      HTTP-Server, zwei Routen, Prompt bauen, Prozess starten,
                Ausgabe in OpenAI-Form übersetzen
Umgebung        BRIDGE_PORT, ein Geheimnis für den Zugang,
                optional ein Rückfall-Token
```

Mehr braucht es nicht.
