// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";

import { ufetch } from "ufetch";
import { exec, spawn } from "child_process";
import fs from "fs";
import path from "path";
import {
  EXTENSION_NAME,
  COMMANDS,
  isValidFilePath,
  updateModelRegistryPath,
  getCurrentWorkingDirectory,
  sanitizeFileName,
  getTodayDateString,
  LASTMILE_BASE_URI,
  isSupportedConfigExtension,
  SUPPORTED_FILE_EXTENSIONS,
  setupEnvironmentVariables,
} from "./util";
import {
  getPythonPath,
  initialize,
  savePythonInterpreterToCache,
} from "./utilities/pythonSetupUtils";
import { AIConfigEditorProvider } from "./aiConfigEditor";
import {
  AIConfigEditorManager,
  AIConfigEditorState,
} from "./aiConfigEditorManager";
import {
  ActiveEnvironmentPathChangeEvent,
  PythonExtension,
} from "@vscode/python-extension";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log(
    `Congratulations, your extension ${EXTENSION_NAME} is now active!`
  );

  // Create an output channel for the extension
  const extensionOutputChannel = vscode.window.createOutputChannel("AIConfig", {
    log: true,
  });

  const setupCommand = vscode.commands.registerCommand(COMMANDS.INIT, () => {
    initialize(context, extensionOutputChannel);
  });
  context.subscriptions.push(setupCommand);

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.SHOW_WELCOME, () => {
      const welcomeFilePath = path.join(
        context.extensionPath,
        "media",
        "welcomePage.md"
      );
      vscode.commands.executeCommand(
        "markdown.showPreview",
        vscode.Uri.file(welcomeFilePath)
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      COMMANDS.SETUP_ENVIRONMENT_VARIABLES,
      async () => {
        await setupEnvironmentVariables(context);
      }
    )
  );

  const createAIConfigJSONCommand = vscode.commands.registerCommand(
    COMMANDS.CREATE_NEW_JSON,
    async () => {
      return await createNewAIConfig(context, aiconfigEditorManager, "json");
    }
  );
  context.subscriptions.push(createAIConfigJSONCommand);

  const createAIConfigYAMLCommand = vscode.commands.registerCommand(
    COMMANDS.CREATE_NEW_YAML,
    async () => {
      return await createNewAIConfig(context, aiconfigEditorManager, "yaml");
    }
  );
  context.subscriptions.push(createAIConfigYAMLCommand);

  const shareModelParserCommand = vscode.commands.registerCommand(
    COMMANDS.SHARE,
    async () => {
      return await shareAIConfig(context, aiconfigEditorManager);
    }
  );
  context.subscriptions.push(shareModelParserCommand);

  const customModelParserCommand = vscode.commands.registerCommand(
    COMMANDS.CUSTOM_MODEL_REGISTRY_PATH,
    async () => {
      return await registerCustomModelRegistry(aiconfigEditorManager);
    }
  );
  context.subscriptions.push(customModelParserCommand);

  const createCustomModelRegistryCommand = vscode.commands.registerCommand(
    COMMANDS.CREATE_CUSTOM_MODEL_REGISTRY,
    async () => {
      return await createCustomModelRegistry(context, aiconfigEditorManager);
    }
  );
  context.subscriptions.push(createCustomModelRegistryCommand);

  const openConfigFileCommand = vscode.commands.registerCommand(
    COMMANDS.OPEN_CONFIG_FILE,
    async () => {
      return await openConfigFile();
    }
  );
  context.subscriptions.push(openConfigFileCommand);

  const openModelParserCommand = vscode.commands.registerCommand(
    COMMANDS.OPEN_MODEL_REGISTRY,
    async () => {
      return await openModelRegistry(context, aiconfigEditorManager);
    }
  );
  context.subscriptions.push(openModelParserCommand);

  // Register our custom editor providers
  const aiconfigEditorManager: AIConfigEditorManager =
    new AIConfigEditorManager();

  context.subscriptions.push(
    AIConfigEditorProvider.register(
      context,
      extensionOutputChannel,
      aiconfigEditorManager
    )
  );

  // Also handle file renames/moves -- inform the EditorManager of the change
  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles((e) => {
      e.files.forEach(async (file) => {
        const editor = aiconfigEditorManager.getEditorByUri(
          file.oldUri.toString()
        );
        if (editor) {
          aiconfigEditorManager.removeEditorByUri(file.oldUri.toString());
          aiconfigEditorManager.addEditor(editor, file.newUri.toString());
        }
      });
    })
  );

  const pythonapi = await PythonExtension.api();
  context.subscriptions.push(
    pythonapi.environments.onDidChangeActiveEnvironmentPath(
      async (e: ActiveEnvironmentPathChangeEvent) => {
        await savePythonInterpreterToCache();
        const editors: Array<AIConfigEditorState> = Array.from(
          aiconfigEditorManager.getRegisteredEditors()
        );
        if (editors.length > 0) {
          vscode.window
            .showInformationMessage(
              "Python Interpreter Updated: Would you like to refresh active AIConfig files?",
              ...["Yes", "No"]
            )
            .then((selection) => {
              if (selection === "Yes") {
                editors.forEach((editor) => {
                  // Next PR: refresh editor here
                  vscode.window.showInformationMessage("Refresh boiiiiii");
                });
              }
            });
        }
      }
    )
  );
}

// This method is called when your extension is deactivated
export function deactivate() {
  console.log("Deactivated AIConfig extension");
}

/**
 * Creates a new AIConfig file in the editor.
 */
async function createNewAIConfig(
  context: vscode.ExtensionContext,
  aiconfigEditorManager: AIConfigEditorManager,
  mode: "json" | "yaml" = "json"
) {
  const workspaceUri = vscode.workspace.workspaceFolders
    ? vscode.workspace.workspaceFolders[0].uri
    : null;
  const untitledUri = workspaceUri
    ? workspaceUri.with({
        scheme: "untitled",
        path: `${workspaceUri.path}/untitled.aiconfig.${mode}`,
      })
    : vscode.Uri.parse(`untitled:untitled.aiconfig.${mode}`);

  // Specify the initial content here
  const newAIConfigJSON = vscode.Uri.joinPath(
    context.extensionUri,
    "static",
    "untitled.aiconfig.json"
  );

  const newAIConfigYAML = vscode.Uri.joinPath(
    context.extensionUri,
    "static",
    "untitled.aiconfig.yaml"
  );

  const fileContentPath = mode === "json" ? newAIConfigJSON : newAIConfigYAML;

  const fileContentBuffer = await vscode.workspace.fs.readFile(fileContentPath);
  const initialContent = fileContentBuffer.toString();

  const doc = await vscode.workspace.openTextDocument({
    content: initialContent,
    language: mode,
  });

  //const doc = await vscode.workspace.openTextDocument(untitledUri);
  await vscode.window.showTextDocument(doc, {
    preview: false,
    viewColumn: vscode.ViewColumn.One,
  });

  await vscode.commands.executeCommand(
    "vscode.openWith",
    doc.uri,
    AIConfigEditorProvider.viewType
  );
}

/**
 *
 */
async function openConfigFile() {
  let defaultUri;
  const activeDocument = vscode.window.activeTextEditor?.document;

  if (activeDocument && isSupportedConfigExtension(activeDocument.fileName)) {
    defaultUri = activeDocument.uri;
  }

  const openUri = await vscode.window.showOpenDialog({
    defaultUri,
    filters: {
      // Allow opening .json and .yaml files regardless of .aiconfig. sub-extension
      "AIConfig Extension": SUPPORTED_FILE_EXTENSIONS,
    },
  });

  if (openUri) {
    const doc = await vscode.workspace.openTextDocument(openUri[0]);

    await vscode.commands.executeCommand(
      "vscode.openWith",
      doc.uri,
      AIConfigEditorProvider.viewType
    );
  }
}

/**
 * Opens the currently registered custom model registry file in the editor.
 * If none is found, prompts the user to create a new one or use a pre-existing one.
 */
async function openModelRegistry(
  context: vscode.ExtensionContext,
  aiconfigEditorManager: AIConfigEditorManager
) {
  const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
  const savedModelRegistryPath = config.get<string>("modelRegistryPath");
  if (!savedModelRegistryPath) {
    vscode.window
      .showWarningMessage(
        "No custom model registry path has been set. Please set one first.",
        ...["Create", "Use Existing"]
      )
      .then((selection) => {
        if (selection === "Create") {
          createCustomModelRegistry(context, aiconfigEditorManager);
        } else if (selection === "Use Existing") {
          registerCustomModelRegistry(aiconfigEditorManager);
        }
      });
    return;
  }

  const doc = await vscode.workspace.openTextDocument(savedModelRegistryPath);
  if (doc) {
    vscode.window.showTextDocument(doc);
  } else {
    vscode.window
      .showErrorMessage(
        `Error opening model registry file ${savedModelRegistryPath}`,
        ...["Create New", "Use Existing"]
      )
      .then((selection) => {
        if (selection === "Create") {
          createCustomModelRegistry(context, aiconfigEditorManager);
        } else if (selection === "Use Existing") {
          registerCustomModelRegistry(aiconfigEditorManager);
        }
      });
  }
}

/**
 * Creates a new custom model registry file and registers it with the extension.
 */
async function createCustomModelRegistry(
  context: vscode.ExtensionContext,
  aiconfigEditorManager: AIConfigEditorManager
) {
  let closestDirectory = null;
  const activeEditor = aiconfigEditorManager.getActiveEditor();
  if (activeEditor?.document && !activeEditor.document.isUntitled) {
    closestDirectory = path.dirname(activeEditor.document.fileName);
  } else if (vscode.window.activeTextEditor?.document) {
    closestDirectory = path.dirname(
      vscode.window.activeTextEditor.document.fileName
    );
  } else {
    closestDirectory = getCurrentWorkingDirectory(null);
  }

  let defaultModelRegistryPath = path.join(
    closestDirectory,
    "aiconfig_model_registry.py"
  );

  const modelRegistryPath = await vscode.window.showInputBox({
    prompt: "Enter the path to create the model registry file",
    value: defaultModelRegistryPath,
    validateInput: (text) => {
      if (!text) {
        return "File path is required";
      }

      return null;
    },
  });

  if (!modelRegistryPath) {
    vscode.window.showInformationMessage("Model registry creation cancelled");
    return;
  }

  // Create the model registry file from the sample
  const sampleModelRegistryPath = vscode.Uri.joinPath(
    context.extensionUri,
    "static",
    "example_aiconfig_model_registry.py"
  );

  try {
    await vscode.workspace.fs.copy(
      sampleModelRegistryPath,
      vscode.Uri.file(modelRegistryPath),
      { overwrite: false }
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Error creating new file ${modelRegistryPath}. Error is ${err}`
    );
  }

  const doc = await vscode.workspace.openTextDocument(modelRegistryPath);
  if (doc) {
    vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(
      "Please customize your new model registry."
    );
  }

  let config = vscode.workspace.getConfiguration(EXTENSION_NAME);
  await handleCustomModelRegistryUpdate(
    config,
    aiconfigEditorManager,
    modelRegistryPath
  );
}

/**
 * Registers (and persists) the custom model registry path with the extension and all open aiconfig editors.
 */
async function registerCustomModelRegistry(
  aiconfigEditorManager: AIConfigEditorManager
) {
  let config = vscode.workspace.getConfiguration(EXTENSION_NAME);
  let savedModelRegistryPath = config.get<string>("modelRegistryPath");

  const modelRegistryPath = await vscode.window.showInputBox({
    prompt: "Enter the path to the file containing your custom model registry",
    value: savedModelRegistryPath,
    validateInput: (text) => {
      if (!text) {
        return "File path is required";
      }

      if (!isValidFilePath(text)) {
        return "File path is not valid or file does not exist";
      }

      return null;
    },
  });
}

async function handleCustomModelRegistryUpdate(
  config: vscode.WorkspaceConfiguration,
  aiconfigEditorManager: AIConfigEditorManager,
  modelRegistryPath: string
) {
  // TODO: saqadri - ask the user if they want us to apply the setting globally
  await config.update(
    "modelRegistryPath",
    modelRegistryPath,
    vscode.ConfigurationTarget.Workspace
  );

  vscode.window.showInformationMessage(
    `Custom model registry path updated to ${modelRegistryPath}`
  );

  // Now go through all the open AIConfig documents and update the model registry for their servers
  const aiconfigEditors = aiconfigEditorManager.getRegisteredEditors();
  const promises: Promise<string>[] = [];
  for (const editor of aiconfigEditors) {
    if (editor.editorServer) {
      promises.push(
        updateModelRegistryPath(editor.editorServer.url, modelRegistryPath)
      );
    }
  }

  // TODO: saqadri - this by itself isn't enough -- we also need to reload the aiconfigs
  await Promise.allSettled(promises);

  vscode.window.showInformationMessage(
    `Updated model registry for open aiconfigs to ${modelRegistryPath}`
  );
}

async function shareAIConfig(
  context: vscode.ExtensionContext,
  aiconfigEditorManager: AIConfigEditorManager
) {
  // Get the current active aiconfig editor
  const activeEditor = aiconfigEditorManager.getActiveEditor();
  if (!activeEditor) {
    vscode.window.showErrorMessage(
      "No AIConfig file is currently open in the editor. Please open the file you want to share and try again."
    );
    return;
  }

  const fileName: string = activeEditor.document.fileName;
  const sanitizedFileName: string = sanitizeFileName(fileName);

  // TODO: Add back once CORS is resolved
  // const policyResponse = await fetch(
  //   "https://lastmileai.dev/api/upload/publicpolicy"
  // );
  // const policy = await policyResponse.json();
  const uploadUrl = "https://s3.amazonaws.com/lastmileai.aiconfig.public/";
  const randomPath = Math.round(Math.random() * 10000);
  const uploadKey: string = `aiconfigs/${getTodayDateString()}/${randomPath}/${sanitizedFileName}`;

  // TODO: Will also need to check for yaml files and change the contentType accordingly
  const contentType = "application/json";

  const formData = new FormData();
  formData.append("key", uploadKey);
  formData.append("acl", "public-read");
  formData.append("Content-Type", contentType);
  formData.append("success_action_status", "201");
  const configString = activeEditor.document.getText();
  const fileBlob = new Blob([configString], {
    type: contentType,
  });
  formData.append("file", fileBlob);

  // See this about changing to use XMLHTTPRequest to show upload progress as well
  // https://medium.com/@cpatarun/tracking-file-upload-progress-to-amazon-s3-from-the-browser-71be6712c63d
  await fetch(uploadUrl, {
    method: "POST",
    mode: "cors",
    // TODO: Investigate whether this is needed, since it's used in AttachmentUploader (https://github.com/lastmile-ai/aiconfig/blob/a741af3221976caa73a32e57a8833af7a3148390/python/src/aiconfig/editor/client/src/components/prompt/prompt_input/attachments/AttachmentUploader.tsx#L61C5-L62C1)
    // but causes the code here to error on compile
    // cache: "no-cache",
    body: formData,
    headers: {
      Authorization: "",
    },
  });

  const s3Url: string = `${uploadUrl}${uploadKey.replace(/[ ]/g, "%20")}`;

  const lastmileUploadUrl: string = LASTMILE_BASE_URI + "api/aiconfig/upload";
  const response = await ufetch.post(lastmileUploadUrl, {
    url: s3Url,
    source: "vscode",
  });
  if (response?.id !== null && response?.id !== undefined) {
    const permalink: string = LASTMILE_BASE_URI + `aiconfig/${response?.id}`;

    vscode.window
      .showInformationMessage(
        "Would you like to open or copy the link?",
        ...["Open", "Copy Link"]
      )
      .then((selection) => {
        if (selection === "Open") {
          vscode.env.openExternal(vscode.Uri.parse(permalink));
        } else if (selection === "Copy Link") {
          vscode.env.clipboard.writeText(permalink).then(
            () => {
              vscode.window.showInformationMessage(
                "Link copied to clipboard. Happy sharing!"
              );
            },
            (err) => {
              vscode.window.showErrorMessage("Failed to copy link: " + err);
            }
          );
        }
      });
  } else {
    vscode.window
      .showErrorMessage(
        "Failed to upload AIConfig to get a shareable permalink.",
        ...["Retry"]
      )
      .then((selection) => {
        if (selection === "Retry") {
          shareAIConfig(context, aiconfigEditorManager);
        }
      });
  }
}
