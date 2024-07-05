import path = require('path');
import * as vscode from 'vscode'
import Parser =require( "web-tree-sitter");
import { CreateSymbolTableResult, createSymbolTable } from '../symbol_table/create_symbol_table';
import { Range } from 'vscode';


let diagnostics = vscode.languages.createDiagnosticCollection('Tamarin');
let symbolTables = new Map<string, CreateSymbolTableResult>();


//Permet d'obtenir l'indice du noeud actuel par rapport a son père
function get_child_index(node : Parser.SyntaxNode): number|null{
    if(node.parent === null ){
        return null;
    }
    const children = node.parent.children;
    for (let i = 0; i < children.length; i++) {
      if (children[i].id === node.id) {
        return i >= 0 ? i : null;
      }
    }
    return 0;

}

export function getName(node : Parser.SyntaxNode| null, editor: vscode.TextEditor): string {
    if(node && node.isNamed ){
        return(editor.document.getText(new Range(editor.document.positionAt(node.startIndex),editor.document.positionAt(node.endIndex))));
        
    }
    else{
        return "None"
    }
}






export async function detect_errors(editeur: vscode.TextEditor): Promise<Parser.SyntaxNode|void> {
    let editor = editeur;
    await Parser.init();
    const parser = new Parser();
    const parserPath = path.join(__dirname + '../../../', 'src', 'grammar', 'parser-tamarin.wasm'); //Charge la grammaire tree-sitter pour parser
    const Tamarin =  await Parser.Language.load(parserPath);
    parser.setLanguage(Tamarin);
    if (!editor) {
        return;
    }
    let diags: vscode.Diagnostic[] = [];
    let text = editor.document.getText();
    const tree =  parser.parse(text);
    
    function build_error_display(node : Parser.SyntaxNode, editeur: vscode.TextEditor, message : string){
        let start = node.startIndex;
        let positionStart = editeur.document.positionAt(start);
        let existingDiag = diags.find(d => d.range.contains(positionStart)); // Evite les superpositions de diagnostics
        if (!existingDiag) {
        diags.push(new vscode.Diagnostic(new vscode.Range(positionStart, positionStart.translate(0,0) ), message, vscode.DiagnosticSeverity.Error));
        }
    }


    function typesOfError(node : Parser.SyntaxNode, editeur: vscode.TextEditor){
        if(node.grammarType === 'theory' || node.nextSibling?.nextSibling?.grammarType === 'begin' || node.nextSibling?.grammarType === 'begin'){
            build_error_display(node, editeur, "MISSING 'theory' or 'begin'")

        }
        else if(node.firstChild?.grammarType === "builtins" || node.firstChild?.grammarType === "functions" || node.firstChild?.grammarType === "macros" ){
            build_error_display(node, editeur, "MISSING ':' ");
        }
        else if ( node.nextSibling?.grammarType === 'built_in'){
            build_error_display(node, editeur, "MISSING ',' ");   
        }
        else if(node.firstChild?.grammarType === "rule" && (node.firstChild.nextSibling?.grammarType != "ident" || node.firstChild.nextSibling?.nextSibling?.grammarType != ":") ){
            build_error_display(node, editeur, "MISSING ':' or rule name ");
        }
        else if(node.firstChild?.grammarType === "lemma"){
            build_error_display(node, editeur, "MISSING ':' or lemma name ");
        }
        else if (node.firstChild?.grammarType === "premise" || (node.firstChild?.grammarType === "rule" && (node.firstChild.nextSibling?.grammarType === "ident" || node.firstChild.nextSibling?.nextSibling?.grammarType === ":"))){
            build_error_display(node, editeur, "ERROR in rule structure the syntax for a rule is either \n []-->[] \n or \n []--[]->[]")
        }
        else if(node.firstChild?.grammarType === "pre_defined"){
            build_error_display(node, editeur, "MISSING generalized quantifier");
        }
        else if (node.firstChild?.grammarType === "nested_formula" || node.firstChild?.grammarType === "action_constraint" || node.firstChild?.grammarType === "conjunction"){
            build_error_display(node, editeur, "EXPECTING '&', '∧', '|', '∨', '==>'");
        }
        else {
            build_error_display(node, editeur, node.toString().slice(1,-1));
        }
    }

    // Trouve les noeuds d'erreur ou de warning
    function findMatches(node : Parser.SyntaxNode, editeur: vscode.TextEditor ) {
        if ((node.isMissing)) {
            let myId = get_child_index(node);
            if(myId === null){
                return ;
            }
            if(node.parent?.child(myId-1)?.type === 'single_comment'){
                let start ;
                if(node.parent.child(myId-2) != null ){
                    start = node.parent.child(myId-2)?.endIndex;
                }
                else {
                    start = 0
                }
                let positionStart = editeur.document.positionAt(start?? 0);
                let existingDiag = diags.find(d => d.range.contains(positionStart)); 
                if (!existingDiag) {
                    diags.push(new vscode.Diagnostic(new vscode.Range(positionStart, positionStart.translate(0,1) ), node.toString().slice(1, -1), vscode.DiagnosticSeverity.Error));
                }
            }
            else {
            build_error_display(node, editeur ,node.toString().slice(1,-1));
            }
        }
        else if (node.isError){
            if (node.firstChild && node.firstChild.grammarType === "multi_comment") {
                const childNode = node.child(1);
                if (childNode) {
                  typesOfError(childNode, editeur);
                }
            } 
            else {
                typesOfError(node, editeur);
            }

            diagnostics.set(editeur.document.uri, diags);
            return;
        }
        else if (node.grammarType === 'end'){
        const endPosition = editor.document.positionAt(node.endIndex);
        const endOfDocumentPosition = editor.document.positionAt(editor.document.getText().length);
        const unreachableRange = new vscode.Range(endPosition, endOfDocumentPosition);
        const unreachableDecoration = vscode.window.createTextEditorDecorationType({
            textDecoration: 'none; opacity: 0.5; background-color: none; border: none;',
            dark: {
                textDecoration: 'none; opacity: 0.5; background-color: none; border: none;',
            }
        });
        let hasContentAfterEnd = false;
        const text = editor.document.getText();
        for (let lineNum = endPosition.line + 1; lineNum <= endOfDocumentPosition.line; lineNum++) {
            const line = text.split('\n')[lineNum];
            if (line.trim() !== '') {
                hasContentAfterEnd = true;
                break;
            }
        }
        if (!hasContentAfterEnd) {
            return;
        }
        editor.setDecorations(unreachableDecoration, [unreachableRange]);
        const message = "Code unreachable";
        const severity = vscode.DiagnosticSeverity.Warning;
        const diagnostic = new vscode.Diagnostic(unreachableRange, message, severity);
        diags.push(diagnostic);
        }

        
        for (let child of node.children) {
            findMatches(child,editeur);
        }
        
    }

    findMatches(tree.rootNode,editor);

    diagnostics.set(editor.document.uri, diags);

    return tree.rootNode;
    
}


//Fonction principale 
export function display_syntax_errors(context: vscode.ExtensionContext): void {
    const changed_content = vscode.workspace.onDidChangeTextDocument((event) => {
        vscode.window.visibleTextEditors.forEach(async (editor) => {
            if (editor.document === event.document) {
                const tree = await detect_errors(editor);
                if (tree) {
                    const table = createSymbolTable(tree, editor);
                    const fileName = editor.document.uri.path.split('/').pop(); 
                    if (!fileName) {
                        throw new Error('Could not determine file name');
                    }  
                    symbolTables.set(fileName, table); 
                    console.log(symbolTables);
                }
            }
        });
    });

    // Appeler les fonctions du plugin pour tous les éditeurs visibles
    vscode.window.visibleTextEditors.forEach(async (editor) => {
        const tree = await detect_errors(editor);
        if (tree) {
            const table = createSymbolTable(tree, editor);
            const fileName = editor.document.uri.path.split('/').pop();           
            if (!fileName) {
                throw new Error('Could not determine file name');
            }  
            symbolTables.set(fileName, table);  
        }
    });

    context.subscriptions.push(changed_content, diagnostics);  
}





