// Extended In Your Face - Animated Doomguy with click-to-jump-to-error
// Based on the original by Virej Dasani
// New features:
//   - Animated face look-around (left/center/right) per health state
//   - Click face to jump to next error
//   - Message-passing architecture (no more full HTML rebuild every second)

"use strict";

import * as vscode from "vscode";

// Health state thresholds — maps error count to damage level (0=healthy, 4=critical)
function getHealthState(errors: number): number {
  if (errors === 0) {
    return 0;
  }
  if (errors < 3) {
    return 1;
  }
  if (errors < 6) {
    return 2;
  }
  if (errors < 10) {
    return 3;
  }
  return 4;
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new CustomSidebarViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CustomSidebarViewProvider.viewType,
      provider,
    ),
  );

  // Register jump-to-next-error command (for keybind support)
  context.subscriptions.push(
    vscode.commands.registerCommand("in-your-face.jumpToNextError", () => {
      vscode.commands.executeCommand("editor.action.marker.nextInFiles");
    }),
  );

  // Track diagnostics and push updates to the webview
  let lastState = -1;
  let lastErrors = -1;
  let lastWarnings = -1;

  function pushDiagnosticUpdate() {
    const [errors, warnings] = getNumErrors();
    const state = getHealthState(errors);

    // Only push if something changed
    if (
      state !== lastState ||
      errors !== lastErrors ||
      warnings !== lastWarnings
    ) {
      lastState = state;
      lastErrors = errors;
      lastWarnings = warnings;
      provider.updateState(state, errors, warnings);
    }
  }

  // Listen for diagnostic changes
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics(() => {
      pushDiagnosticUpdate();
    }),
  );

  // Update on editor switch
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      // Reset to force an update since the file changed
      lastState = -1;
      lastErrors = -1;
      lastWarnings = -1;
      pushDiagnosticUpdate();
    }),
  );

  // Update on document open
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(() => {
      pushDiagnosticUpdate();
    }),
  );
}

class CustomSidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "in-your-face.openview";

  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  /** Send a state update to the webview */
  public updateState(state: number, errors: number, warnings: number) {
    if (this._view) {
      this._view.webview.postMessage({
        type: "updateState",
        state,
        errors,
        warnings,
      });
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext<unknown>,
    _token: vscode.CancellationToken,
  ): void | Thenable<void> {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    // Build the HTML with all face URIs baked in
    webviewView.webview.html = this._getHtmlContent(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case "jumpToError":
          vscode.commands.executeCommand("editor.action.marker.nextInFiles");
          break;
      }
    });

    // Push initial state
    const [errors, warnings] = getNumErrors();
    const state = getHealthState(errors);
    this.updateState(state, errors, warnings);
  }

  private _getHtmlContent(webview: vscode.Webview): string {
    const config = vscode.workspace.getConfiguration("InYourFace");
    const useWarnings = config.get<boolean>("error.usewarnings") || false;

    const stylesheetUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "assets", "main.css"),
    );

    // Generate URIs for all face images
    // 5 health states × 3 angles (left, center, right) = 15 face images
    // TODO: opus did a bad job cutting up the doomguy sprite sheet, so we will cut them up ourselves so that existing image names work as is but we can add new ones later if we want to do a more accurate sprite sheet cut
    const faceUris: Record<string, string> = {};
    const angles = ["left", "center", "right"];
    for (let state = 0; state < 5; state++) {
      for (const angle of angles) {
        const key = `doom${state}_${angle}`;
        faceUris[key] = webview
          .asWebviewUri(
            vscode.Uri.joinPath(
              this._extensionUri,
              "assets",
              "faces",
              `${key}.png`,
            ),
          )
          .toString();
      }
      // Ouch face for each state
      const ouchKey = `doom${state}_ouch`;
      faceUris[ouchKey] = webview
        .asWebviewUri(
          vscode.Uri.joinPath(
            this._extensionUri,
            "assets",
            "faces",
            `${ouchKey}.png`,
          ),
        )
        .toString();
    }

    // God mode face
    faceUris["doom_god"] = webview
      .asWebviewUri(
        vscode.Uri.joinPath(
          this._extensionUri,
          "assets",
          "faces",
          "doom_god.png",
        ),
      )
      .toString();

    const faceUrisJson = JSON.stringify(faceUris);

    return /* html */ `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="stylesheet" href="${stylesheetUri}" />
      </head>
      <body>
        <section>
          <div id="face-container" title="Click to jump to next error">
            <img id="doom-face" src="" alt="Doomguy" />
          </div>
          <h2 id="error-count"></h2>
        </section>

        <script>
          (function() {
            const vscode = acquireVsCodeApi();
            const faceUris = ${faceUrisJson};
            const useWarnings = ${useWarnings};

            const faceImg = document.getElementById('doom-face');
            const errorCountEl = document.getElementById('error-count');
            const faceContainer = document.getElementById('face-container');

            // Current state
            let currentState = 0;
            let currentErrors = 0;
            let currentWarnings = 0;

            // Animation state
            const angles = ['left', 'center', 'right'];
            let currentAngleIndex = 1; // Start looking forward
            let animationTimer = null;
            let isOuching = false;

            // Pick a random angle for the look-around animation
            // Weighted towards center (more natural feel)
            function pickRandomAngle() {
              const weights = [0.25, 0.50, 0.25]; // left, center, right
              const rand = Math.random();
              if (rand < weights[0]) return 0;
              if (rand < weights[0] + weights[1]) return 1;
              return 2;
            }

            // Update the displayed face image
            function updateFaceImage() {
              if (isOuching) return; // Don't interrupt ouch animation

              const angle = angles[currentAngleIndex];
              const key = 'doom' + currentState + '_' + angle;
              if (faceUris[key]) {
                faceImg.src = faceUris[key];
              }
            }

            // Flash the ouch face briefly when errors increase
            let prevErrors = 0;
            function triggerOuch() {
              isOuching = true;
              const ouchKey = 'doom' + currentState + '_ouch';
              if (faceUris[ouchKey]) {
                faceImg.src = faceUris[ouchKey];
              }
              setTimeout(() => {
                isOuching = false;
                updateFaceImage();
              }, 800);
            }

            // Start the look-around animation loop
            function startAnimation() {
              if (animationTimer) clearInterval(animationTimer);

              // Random interval between 400-1200ms for natural feel
              function scheduleNext() {
                const delay = 400 + Math.random() * 800;
                animationTimer = setTimeout(() => {
                  currentAngleIndex = pickRandomAngle();
                  updateFaceImage();
                  scheduleNext();
                }, delay);
              }
              scheduleNext();
            }

            // Update error/warning text
            function updateErrorText() {
              const parts = [];
              parts.push(currentErrors + ' ' + (currentErrors === 1 ? 'error' : 'errors'));
              if (useWarnings) {
                parts.push(currentWarnings + ' ' + (currentWarnings === 1 ? 'warning' : 'warnings'));
              }
              errorCountEl.textContent = parts.join('  ');

              // Update CSS class for color
              errorCountEl.className = '';
              if (currentErrors > 0) {
                errorCountEl.className = 'alarm';
              } else if (useWarnings && currentWarnings > 0) {
                errorCountEl.className = 'yellow';
              }
            }

            // Handle state updates from the extension
            window.addEventListener('message', (event) => {
              const message = event.data;
              if (message.type === 'updateState') {
                const oldErrors = currentErrors;
                currentState = message.state;
                currentErrors = message.errors;
                currentWarnings = message.warnings;

                // Trigger ouch face if errors increased
                if (currentErrors > oldErrors && oldErrors >= 0) {
                  triggerOuch();
                } else {
                  updateFaceImage();
                }

                updateErrorText();
              }
            });

            // Click to jump to next error
            faceContainer.addEventListener('click', () => {
              vscode.postMessage({ command: 'jumpToError' });
            });

            // Initialize
            updateFaceImage();
            updateErrorText();
            startAnimation();
          })();
        </script>
      </body>
    </html>
    `;
  }
}

// Get the number of errors and warnings in the active file
function getNumErrors(): [number, number] {
  const activeTextEditor = vscode.window.activeTextEditor;
  if (!activeTextEditor) {
    return [0, 0];
  }

  const document = activeTextEditor.document;
  let numErrors = 0;
  let numWarnings = 0;

  for (const diagnostic of vscode.languages.getDiagnostics(document.uri)) {
    switch (diagnostic.severity) {
      case 0: // Error
        numErrors += 1;
        break;
      case 1: // Warning
        numWarnings += 1;
        break;
    }
  }

  return [numErrors, numWarnings];
}

export function deactivate() {}
