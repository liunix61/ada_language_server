import assert from 'assert';
import { existsSync } from 'fs';
import * as vscode from 'vscode';
import { SymbolKind } from 'vscode';
import { Disposable } from 'vscode-jsonrpc';
import { ExecuteCommandRequest } from 'vscode-languageclient';
import { ExtensionState } from './ExtensionState';
import { getOrAskForProgram } from './debugConfigProvider';
import { adaExtState, mainOutputChannel } from './extension';
import { getProjectFileRelPath } from './helpers';
import {
    CustomTaskDefinition,
    getConventionalTaskLabel,
    getEnclosingSymbol,
    isFromWorkspace,
} from './taskProviders';

export function registerCommands(context: vscode.ExtensionContext, clients: ExtensionState) {
    context.subscriptions.push(vscode.commands.registerCommand('ada.otherFile', otherFileHandler));
    context.subscriptions.push(
        vscode.commands.registerCommand('ada.subprogramBox', addSupbrogramBoxCommand)
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('ada.showExtensionOutput', () => mainOutputChannel.show())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('ada.showAdaLSOutput', () =>
            clients.adaClient.outputChannel.show()
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('ada.showGprLSOutput', () =>
            clients.gprClient.outputChannel.show()
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ada.runMainLast', () => runMainLast())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ada.runMainAsk', () => runMainAsk())
    );

    // This is a hidden command that gets called in the default debug
    // configuration snippet that gets offered in the launch.json file.
    // It is expected to return the relative path of the main program chosen for
    // debugging.
    context.subscriptions.push(
        vscode.commands.registerCommand('ada.getOrAskForProgram', async () => {
            const p = await getOrAskForProgram();
            return p?.execRelPath();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'ada.addMissingDirsToWorkspace',
            async (
                // eslint-disable-next-line @typescript-eslint/no-inferrable-types
                atStartup: boolean = false,
                // eslint-disable-next-line @typescript-eslint/no-inferrable-types
                displayYesNoPopup: boolean = true
            ) => {
                await checkSrcDirectories(atStartup, displayYesNoPopup);
            }
        )
    );
}
/**
 * Add a subprogram box above the subprogram enclosing the cursor's position, if any.
 *
 * @example
 *
 *  -------
 *  - Foo -
 *  -------
 *
 *  procedure Foo is
 */
async function addSupbrogramBoxCommand() {
    const activeEditor = vscode.window.activeTextEditor;

    await getEnclosingSymbol(activeEditor, [
        SymbolKind.Function,
        SymbolKind.Package,
        SymbolKind.Module,
    ]).then(async (symbol) => {
        if (symbol !== null) {
            const name: string = symbol.name ?? '';
            const insertPos = new vscode.Position(symbol.range.start.line, 0);
            const indentationRange = new vscode.Range(insertPos, symbol.range.start);
            const indentation: string = activeEditor?.document.getText(indentationRange) ?? '';
            const eol: string = activeEditor?.document.eol == vscode.EndOfLine.CRLF ? '\r\n' : '\n';

            // Generate the subprogram box after retrieving the indentation of the line of
            // the subprogram's body declaration.
            const text: string =
                indentation +
                '---' +
                '-'.repeat(name.length) +
                '---' +
                eol +
                indentation +
                '-- ' +
                name +
                ' --' +
                eol +
                indentation +
                '---' +
                '-'.repeat(name.length) +
                '---' +
                eol +
                eol;

            if (activeEditor) {
                await activeEditor.edit((editBuilder) => {
                    editBuilder.insert(insertPos, text);
                });
            }
        }
    });
}

let lastUsedTaskInfo: { source: string; name: string } | undefined;

/**
 * If a task was previously run through the commands `ada.runMainAsk` or
 * `ada.runMainLast`, re-run the same task. If not, defer to {@link runMainAsk}
 * to ask the User to select a task to run.
 *
 * @returns the TaskExecution corresponding to the task.
 */
async function runMainLast() {
    const buildAndRunTasks = await getBuildAndRunTasks();
    if (lastUsedTaskInfo) {
        const matchingTasks = buildAndRunTasks.filter(matchesLastUsedTask);
        assert(matchingTasks.length <= 1);
        const lastTask = matchingTasks.length == 1 ? matchingTasks[0] : undefined;
        if (lastTask) {
            return await vscode.tasks.executeTask(lastTask);
        }
    }

    // No task was run so far, or the last one run no longer exists
    return runMainAsk();
}

/**
 *
 * @param t - a task
 * @returns `true` if the given task matches the last executed task
 */
function matchesLastUsedTask(t: vscode.Task): boolean {
    return t.source == lastUsedTaskInfo?.source && t.name == lastUsedTaskInfo?.name;
}

/**
 *
 * @param task - a task
 * @returns the label to be displayed to the user in the quick picker for that task
 */
function getTaskLabel(task: vscode.Task): string {
    return isFromWorkspace(task) ? `(From Workspace) ${task.name}` : getConventionalTaskLabel(task);
}

interface TaskQuickPickItem extends vscode.QuickPickItem {
    task: vscode.Task;
}

/**
 * Propose to the User a list of build and run tasks, one for each main defined
 * in the project.
 *
 * Tasks defined explicitely in the workspace are identified as such in the
 * offered list and proposed first.
 *
 * The User can choose either to run the task as is, or click the secondary
 * button to add the task to tasks.json (if not already there) and configure it
 * there.
 */
async function runMainAsk() {
    function createQuickPickItem(task: vscode.Task): TaskQuickPickItem {
        return {
            // Mark the last used task with a leading star
            label: (matchesLastUsedTask(task) ? '$(star) ' : '') + getTaskLabel(task),
            // Add a description to the last used task
            description: matchesLastUsedTask(task) ? 'last used' : undefined,
            task: task,
            // Add a button allowing to configure the task in tasks.json
            buttons: [
                {
                    iconPath: new vscode.ThemeIcon('gear'),
                    tooltip: 'Configure task in tasks.json, e.g. to add main arguments',
                },
            ],
        };
    }
    const adaTasksMain = await getBuildAndRunTasks();

    if (adaTasksMain.length > 0) {
        const tasksFromWorkspace = adaTasksMain.filter(isFromWorkspace);
        const tasksFromExtension = adaTasksMain.filter((v) => !isFromWorkspace(v));

        // Propose workspace-configured tasks first
        const quickPickItems: TaskQuickPickItem[] = tasksFromWorkspace.map(createQuickPickItem);

        if (tasksFromWorkspace.length > 0) {
            // Use a separator between workspace tasks and implicit tasks provided by the extension
            quickPickItems.push({
                kind: vscode.QuickPickItemKind.Separator,
                label: '',
                // Use any valid task to avoid allowing 'undefined' in the type declaration
                task: adaTasksMain[0],
            });
        }

        quickPickItems.push(...tasksFromExtension.map(createQuickPickItem));

        // Create the quick picker
        const qp = vscode.window.createQuickPick<TaskQuickPickItem>();
        qp.items = qp.items.concat(quickPickItems);

        // Array for event handlers to be disposed after the quick picker is disposed
        const disposables: Disposable[] = [];
        try {
            const choice: TaskQuickPickItem | undefined = await new Promise((resolve) => {
                // Add event handlers to the quick picker
                disposables.push(
                    qp.onDidChangeSelection((items) => {
                        // When the User selects an option, resolve the Promise
                        // and hide the quick picker
                        const item = items[0];
                        if (item) {
                            resolve(item);
                            qp.hide();
                        }
                    }),
                    qp.onDidHide(() => {
                        resolve(undefined);
                    }),
                    qp.onDidTriggerItemButton(async (e) => {
                        // When the User selects the secondary button, find or
                        // create the task in the tasks.json file

                        // There's only one button, so let's assert that
                        assert(e.item.buttons && e.item.buttons[0]);
                        assert(e.button == e.item.buttons[0]);

                        const tasks: vscode.TaskDefinition[] =
                            vscode.workspace.getConfiguration('tasks').get('tasks') ?? [];

                        // Check if the task is already defined in tasks.json
                        if (!tasks.find((t) => t?.label == getConventionalTaskLabel(e.item.task))) {
                            // If the task doesn't exist, create it

                            // Copy the definition and add a label
                            const def: CustomTaskDefinition = {
                                ...(e.item.task.definition as CustomTaskDefinition),
                                label: getConventionalTaskLabel(e.item.task),
                            };
                            tasks.push(def);
                            await vscode.workspace.getConfiguration().update('tasks.tasks', tasks);
                        }

                        // Then open tasks.json in an editor
                        if (vscode.workspace.workspaceFolders) {
                            const tasksUri = vscode.workspace.workspaceFolders
                                .map((ws) => vscode.Uri.joinPath(ws.uri, '.vscode', 'tasks.json'))
                                .find((v) => existsSync(v.fsPath));
                            if (tasksUri) {
                                await vscode.window.showTextDocument(tasksUri);
                            }
                        }
                        resolve(undefined);
                        qp.hide();
                    })
                );

                // Show the quick picker
                qp.show();
            });

            if (choice) {
                // If a task was selected, mark it as the last executed task and
                // run it
                lastUsedTaskInfo = {
                    source: choice.task.source,
                    name: choice.task.name,
                };
                return await vscode.tasks.executeTask(choice.task);
            } else {
                return undefined;
            }
        } finally {
            disposables.forEach((d) => d.dispose());
        }
    } else {
        void vscode.window.showWarningMessage(
            `There are no Mains defined in the workspace project ${await getProjectFileRelPath()}`
        );
        return undefined;
    }
}

/**
 *
 * @returns Array of tasks of type `ada` and kind `buildAndRunMain`. This
 * includes tasks automatically provided by the extension as well as
 * user-defined tasks in tasks.json.
 */
async function getBuildAndRunTasks() {
    return await vscode.tasks
        .fetchTasks({ type: 'ada' })
        .then((tasks) =>
            tasks.filter(
                (t) =>
                    (t.definition as CustomTaskDefinition).configuration.kind == 'buildAndRunMain'
            )
        );
}

//  Take active editor URI and call execute 'als-other-file' command in LSP
const otherFileHandler = () => {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        return;
    }
    void adaExtState.adaClient.sendRequest(ExecuteCommandRequest.type, {
        command: 'als-other-file',
        arguments: [
            {
                uri: activeEditor.document.uri.toString(),
            },
        ],
    });
};

/**
 *
 * Check if we need to add some source directories to the workspace (e.g: when imported
 * projects' source directories are not placed under the root project's directory).
 * Do nothing if the user did not setup any workspace file.
 *
 * @param alsClient - the running ALS client
 * @param atStartup - whether or not the command is triggered when activating the extension
 * or explicitly by the user later via the Command Palette
 * @param displayYesNoPopup - whether or not we should display a yes/no popup
 * when missing directories
 */
export async function checkSrcDirectories(atStartup = false, displayYesNoPopup = true) {
    type ALSSourceDirDescription = {
        name: string;
        uri: string;
    };

    const foldersInSettings = vscode.workspace.getConfiguration().get('folders');
    const alsClient = adaExtState.adaClient;
    const doNotShowAgainKey = 'ada.addMissingDirsToWorkspace.doNotShowAgain';
    const doNotShowAgain = adaExtState.context.workspaceState.get(doNotShowAgainKey);

    //  Don't propose any popup if we multi-root workspace folders are already set
    //  explicitly in the workspace's settings, or if the command has been
    //  triggered at startup while the user previously clicked on the
    //  'Don't show again' button for this workspace
    if (foldersInSettings === undefined && !(atStartup && doNotShowAgain)) {
        const sourceDirs: ALSSourceDirDescription[] = (await alsClient.sendRequest(
            ExecuteCommandRequest.type,
            {
                command: 'als-source-dirs',
            }
        )) as ALSSourceDirDescription[];

        const isSubdirectory = (dir: string, parent: string) => {
            //  Use lower-case on Windows since drives can be specified in VS Code
            //  either with lower or upper case characters.
            if (process.platform == 'win32') {
                dir = dir.toLowerCase();
                parent = parent.toLowerCase();
            }

            return dir.startsWith(parent + '/');
        };

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const workspaceDirsToAdd: { uri: vscode.Uri; name?: string | undefined }[] = [];

        for (const source_dir of sourceDirs) {
            const sourceDirURI = vscode.Uri.parse(source_dir.uri);
            const sourceDirPath = sourceDirURI.path;

            //  If the source directory is not under one of the workspace folders and
            //  if it's not already present in the workspace's folders, push
            //  this source directory to the workspace folders to add later.
            if (
                !workspaceFolders.some(
                    (workspaceFolder) =>
                        workspaceFolder.uri.path == sourceDirPath ||
                        isSubdirectory(sourceDirPath, workspaceFolder.uri.path)
                )
            ) {
                workspaceDirsToAdd.push({
                    name: source_dir.name,
                    uri: sourceDirURI,
                });
            }
        }

        //  If there are some source directories missing in the workspace, ask the user
        //  to add them in his workspace.
        if (workspaceDirsToAdd.length > 0) {
            let doAdd = true;

            if (displayYesNoPopup) {
                const buttons: ('Yes' | 'No' | "Don't Show Again")[] = ['Yes', 'No'];

                //  Show the 'Don't Show Again' button only at startup
                if (atStartup) {
                    buttons.push("Don't Show Again");
                }

                await vscode.window
                    .showInformationMessage(
                        'Some project source directories are not \
                    listed in your workspace: do you want to add them?',
                        ...buttons
                    )
                    .then((answer) => {
                        if (answer !== 'Yes') {
                            doAdd = false;

                            if (answer === "Don't Show Again") {
                                void adaExtState.context.workspaceState.update(
                                    doNotShowAgainKey,
                                    true
                                );
                            }
                        }
                    });
            }

            if (doAdd) {
                vscode.workspace.updateWorkspaceFolders(
                    vscode.workspace.workspaceFolders
                        ? vscode.workspace.workspaceFolders.length
                        : 0,
                    null,
                    ...workspaceDirsToAdd
                );
            }
        } else if (!atStartup) {
            void vscode.window.showInformationMessage(
                "All the project's source directories are already \
                available in the current workspace."
            );
        }
    }
}
