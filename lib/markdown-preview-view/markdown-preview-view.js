"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const path = require("path");
const atom_1 = require("atom");
const lodash_1 = require("lodash");
const fs = require("fs");
const renderer = require("../renderer");
const markdownIt = require("../markdown-it-helper");
const util_1 = require("../util");
const util = require("./util");
const webview_handler_1 = require("./webview-handler");
const image_watch_helper_1 = require("../image-watch-helper");
class MarkdownPreviewView {
    constructor(defaultRenderMode = 'normal', renderLaTeX = util_1.atomConfig().mathConfig
        .enableLatexRenderingByDefault) {
        this.defaultRenderMode = defaultRenderMode;
        this.renderLaTeX = renderLaTeX;
        this.emitter = new atom_1.Emitter();
        this.disposables = new atom_1.CompositeDisposable();
        this.destroyed = false;
        this.loading = true;
        this.changeHandler = () => {
            util_1.handlePromise(this.renderMarkdown());
            const pane = atom.workspace.paneForItem(this);
            if (pane !== undefined && pane !== atom.workspace.getActivePane()) {
                pane.activateItem(this);
            }
        };
        this.renderPromise = new Promise((resolve) => {
            this.handler = new webview_handler_1.WebviewHandler(() => {
                this.handler.init(atom.getConfigDirPath(), util_1.atomConfig().mathConfig);
                this.handler.setUseGitHubStyle(atom.config.get('markdown-preview-plus.useGitHubStyle'));
                this.handler.setBasePath(this.getPath());
                this.emitter.emit('did-change-title');
                resolve(this.renderMarkdown());
            });
            this.imageWatcher = new image_watch_helper_1.ImageWatcher(this.handler.updateImages.bind(this.handler));
            MarkdownPreviewView.elementMap.set(this.element, this);
        });
        this.runJS = this.handler.runJS.bind(this.handler);
        this.handleEvents();
        this.handler.emitter.on('did-scroll-preview', ({ min, max }) => {
            this.didScrollPreview(min, max);
        });
    }
    get element() {
        return this.handler.element;
    }
    static viewForElement(element) {
        return MarkdownPreviewView.elementMap.get(element);
    }
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.imageWatcher.dispose();
        this.disposables.dispose();
        this.handler.destroy();
        MarkdownPreviewView.elementMap.delete(this.element);
    }
    onDidChangeTitle(callback) {
        return this.emitter.on('did-change-title', callback);
    }
    onDidChangeMarkdown(callback) {
        return this.emitter.on('did-change-markdown', callback);
    }
    toggleRenderLatex() {
        this.renderLaTeX = !this.renderLaTeX;
        this.changeHandler();
    }
    getDefaultLocation() {
        return util_1.atomConfig().previewConfig.previewDock;
    }
    getIconName() {
        return 'markdown';
    }
    getSaveDialogOptions() {
        let defaultPath = this.getPath();
        if (defaultPath === undefined) {
            const projectPath = atom.project.getPaths()[0];
            defaultPath = 'untitled.md';
            if (projectPath) {
                defaultPath = path.join(projectPath, defaultPath);
            }
        }
        defaultPath += '.' + util_1.atomConfig().saveConfig.defaultSaveFormat;
        return { defaultPath };
    }
    saveAs(filePath) {
        if (filePath === undefined)
            return;
        if (this.loading)
            throw new Error('Preview is still loading');
        const { name, ext } = path.parse(filePath);
        if (ext === '.pdf') {
            this.handler.saveToPDF(filePath).catch((error) => {
                atom.notifications.addError('Failed saving to PDF', {
                    description: error.toString(),
                    dismissable: true,
                    stack: error.stack,
                });
            });
        }
        else {
            util_1.handlePromise(this.getHTMLToSave(filePath).then(async (html) => {
                const fullHtml = util.mkHtml(name, html, this.renderLaTeX, atom.config.get('markdown-preview-plus.useGitHubStyle'), await this.handler.getTeXConfig());
                fs.writeFileSync(filePath, fullHtml);
                return atom.workspace.open(filePath);
            }));
        }
    }
    didScrollPreview(_min, _max) {
    }
    openSource(initialLine) {
        const path = this.getPath();
        if (path === undefined)
            return;
        util_1.handlePromise(atom.workspace.open(path, {
            initialLine,
            searchAllPanes: true,
        }));
    }
    syncPreview(line, flash) {
        this.handler.sync(line, flash);
    }
    openNewWindow() {
        const path = this.getPath();
        if (!path) {
            atom.notifications.addWarning('Can not open this preview in new window: no file path');
            return;
        }
        atom.open({
            pathsToOpen: [`markdown-preview-plus://file/${path}`],
            newWindow: true,
        });
        util.destroy(this);
    }
    handleEvents() {
        this.disposables.add(atom.grammars.onDidAddGrammar(() => lodash_1.debounce(() => {
            util_1.handlePromise(this.renderMarkdown());
        }, 250)), atom.grammars.onDidUpdateGrammar(lodash_1.debounce(() => {
            util_1.handlePromise(this.renderMarkdown());
        }, 250)), atom.commands.add(this.element, {
            'core:move-up': () => this.element.scrollBy({ top: -10 }),
            'core:move-down': () => this.element.scrollBy({ top: 10 }),
            'core:copy': () => {
                util_1.handlePromise(this.copyToClipboard());
            },
            'markdown-preview-plus:open-dev-tools': () => {
                this.handler.openDevTools();
            },
            'markdown-preview-plus:new-window': () => {
                this.openNewWindow();
            },
            'markdown-preview-plus:print': () => {
                this.handler.print();
            },
            'markdown-preview-plus:zoom-in': () => {
                this.handler.zoomIn();
            },
            'markdown-preview-plus:zoom-out': () => {
                this.handler.zoomOut();
            },
            'markdown-preview-plus:reset-zoom': () => {
                this.handler.resetZoom();
            },
            'markdown-preview-plus:sync-source': async (_event) => {
                const line = await this.handler.syncSource();
                this.openSource(line);
            },
        }), atom.config.onDidChange('markdown-preview-plus.markdownItConfig', () => {
            if (util_1.atomConfig().renderer === 'markdown-it')
                this.changeHandler();
        }), atom.config.onDidChange('markdown-preview-plus.pandocConfig', () => {
            if (util_1.atomConfig().renderer === 'pandoc')
                this.changeHandler();
        }), atom.config.onDidChange('markdown-preview-plus.mathConfig.latexRenderer', () => {
            util_1.handlePromise(this.handler.reload());
        }), atom.config.onDidChange('markdown-preview-plus.mathConfig.numberEquations', () => {
            util_1.handlePromise(this.handler.reload());
        }), atom.config.onDidChange('markdown-preview-plus.renderer', this.changeHandler), atom.config.onDidChange('markdown-preview-plus.useGitHubStyle', ({ newValue }) => {
            this.handler.setUseGitHubStyle(newValue);
        }));
    }
    async renderMarkdown() {
        const source = await this.getMarkdownSource();
        await this.renderMarkdownText(source);
    }
    async getHTMLToSave(savePath) {
        const source = await this.getMarkdownSource();
        return renderer.render({
            text: source,
            filePath: this.getPath(),
            grammar: this.getGrammar(),
            renderLaTeX: this.renderLaTeX,
            mode: 'save',
            savePath,
        });
    }
    async renderMarkdownText(text) {
        try {
            const domDocument = await renderer.render({
                text,
                filePath: this.getPath(),
                grammar: this.getGrammar(),
                renderLaTeX: this.renderLaTeX,
                mode: this.defaultRenderMode,
                imageWatcher: this.imageWatcher,
            });
            if (this.destroyed)
                return;
            this.loading = false;
            util_1.handlePromise(this.handler.update(domDocument.documentElement.outerHTML, this.renderLaTeX));
            this.handler.setSourceMap(util.buildLineMap(markdownIt.getTokens(text, this.renderLaTeX)));
            this.emitter.emit('did-change-markdown');
        }
        catch (error) {
            this.showError(error);
        }
    }
    showError(error) {
        if (this.destroyed) {
            atom.notifications.addFatalError('Error reported on a destroyed Markdown Preview Plus view', {
                dismissable: true,
                stack: error.stack,
                detail: error.message,
            });
            return;
        }
        this.handler.error(error.message);
    }
    async copyToClipboard() {
        await this.renderPromise;
        const selection = await this.handler.getSelection();
        if (selection !== undefined)
            return;
        const src = await this.getMarkdownSource();
        await util_1.copyHtml(src, this.getPath(), this.renderLaTeX);
    }
}
MarkdownPreviewView.elementMap = new WeakMap();
exports.MarkdownPreviewView = MarkdownPreviewView;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFya2Rvd24tcHJldmlldy12aWV3LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc3JjL21hcmtkb3duLXByZXZpZXctdmlldy9tYXJrZG93bi1wcmV2aWV3LXZpZXcudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSw2QkFBNkI7QUFDN0IsK0JBQXdFO0FBQ3hFLG1DQUFpQztBQUNqQyx5QkFBeUI7QUFFekIsd0NBQXdDO0FBQ3hDLG9EQUFvRDtBQUNwRCxrQ0FBNkQ7QUFDN0QsK0JBQThCO0FBQzlCLHVEQUFrRDtBQUNsRCw4REFBb0Q7QUFRcEQsTUFBc0IsbUJBQW1CO0lBa0J2QyxZQUNVLG9CQUEwRCxRQUFRLEVBQ2xFLGNBQXVCLGlCQUFVLEVBQUUsQ0FBQyxVQUFVO1NBQ25ELDZCQUE2QjtRQUZ4QixzQkFBaUIsR0FBakIsaUJBQWlCLENBQWlEO1FBQ2xFLGdCQUFXLEdBQVgsV0FBVyxDQUNhO1FBWnhCLFlBQU8sR0FHWixJQUFJLGNBQU8sRUFBRSxDQUFBO1FBQ1IsZ0JBQVcsR0FBRyxJQUFJLDBCQUFtQixFQUFFLENBQUE7UUFDdkMsY0FBUyxHQUFHLEtBQUssQ0FBQTtRQUNuQixZQUFPLEdBQVksSUFBSSxDQUFBO1FBMEhyQixrQkFBYSxHQUFHLEdBQUcsRUFBRTtZQUM3QixvQkFBYSxDQUFDLElBQUksQ0FBQyxjQUFjLEVBQUUsQ0FBQyxDQUFBO1lBRXBDLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFBO1lBQzdDLElBQUksSUFBSSxLQUFLLFNBQVMsSUFBSSxJQUFJLEtBQUssSUFBSSxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVBQUUsRUFBRTtnQkFDakUsSUFBSSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsQ0FBQTthQUN4QjtRQUNILENBQUMsQ0FBQTtRQXpIQyxJQUFJLENBQUMsYUFBYSxHQUFHLElBQUksT0FBTyxDQUFDLENBQUMsT0FBTyxFQUFFLEVB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QUN0QixDQUNGLENBQUE7WUFDRCxPQUFNO1NBQ1A7UUFDRCxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUE7SUFDbkMsQ0FBQztJQUVPLEtBQUssQ0FBQyxlQUFlO1FBQzNCLE1BQU0sSUFBSSxDQUFDLGFBQWEsQ0FBQTtRQUN4QixNQUFNLFNBQVMsR0FBRyxNQUFNLElBQUksQ0FBQyxPQUFPLENBQUMsWUFBWSxFQUFFLENBQUE7UUFFbkQsSUFBSSxTQUFTLEtBQUssU0FBUztZQUFFLE9BQU07UUFDbkMsTUFBTSxHQUFHLEdBQUcsTUFBTSxJQUFJLENBQUMsaUJBQWlCLEVBQUUsQ0FBQTtRQUMxQyxNQUFNLGVBQVEsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLE9BQU8sRUFBRSxFQUFFLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQTtJQUN2RCxDQUFDOztBQTlUYyw4QkFBVSxHQUFHLElBQUksT0FBTyxFQUFvQyxDQUFBO0FBRDdFLGtEQWdVQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBwYXRoID0gcmVxdWlyZSgncGF0aCcpXG5pbXBvcnQgeyBFbWl0dGVyLCBEaXNwb3NhYmxlLCBDb21wb3NpdGVEaXNwb3NhYmxlLCBHcmFtbWFyIH0gZnJvbSAnYXRvbSdcbmltcG9ydCB7IGRlYm91bmNlIH0gZnJvbSAnbG9kYXNoJ1xuaW1wb3J0IGZzID0gcmVxdWlyZSgnZnMnKVxuXG5pbXBvcnQgcmVuZGVyZXIgPSByZXF1aXJlKCcuLi9yZW5kZXJlcicpXG5pbXBvcnQgbWFya2Rvd25JdCA9IHJlcXVpcmUoJy4uL21hcmtkb3duLWl0LWhlbHBlcicpXG5pbXBvcnQgeyBoYW5kbGVQcm9taXNlLCBjb3B5SHRtbCwgYXRvbUNvbmZpZyB9IGZyb20gJy4uL3V0aWwnXG5pbXBvcnQgKiBhcyB1dGlsIGZyb20gJy4vdXRpbCdcbmltcG9ydCB7IFdlYnZpZXdIYW5kbGVyIH0gZnJvbSAnLi93ZWJ2aWV3LWhhbmRsZXInXG5pbXBvcnQgeyBJbWFnZVdhdGNoZXIgfSBmcm9tICcuLi9pbWFnZS13YXRjaC1oZWxwZXInXG5cbmV4cG9ydCBpbnRlcmZhY2UgU2VyaWFsaXplZE1QViB7XG4gIGRlc2VyaWFsaXplcjogJ21hcmtkb3duLXByZXZpZXctcGx1cy9NYXJrZG93blByZXZpZXdWaWV3J1xuICBlZGl0b3JJZD86IG51bWJlclxuICBmaWxlUGF0aD86IHN0cmluZ1xufVxuXG5leHBvcnQgYWJzdHJhY3QgY2xhc3MgTWFya2Rvd25QcmV2aWV3VmlldyB7XG4gIHByaXZhdGUgc3RhdGljIGVsZW1lbnRNYXAgPSBuZXcgV2Vha01hcDxIVE1MRWxlbWVudCwgTWFya2Rvd25QcmV2aWV3Vmlldz4oKVxuXG4gIHB1YmxpYyByZWFkb25seSByZW5kZXJQcm9taXNlOiBQcm9taXNlPHZvaWQ+XG4gIHB1YmxpYyByZWFkb25seSBydW5KUzogTWFya2Rvd25QcmV2aWV3Vmlld1snaGFuZGxlciddWydydW5KUyddXG4gIHByb3RlY3RlZCBoYW5kbGVyITogV2Vidmlld0hhbmRsZXJcbiAgcHVibGljIGdldCBlbGVtZW50KCk6IEhUTUxFbGVtZW50IHtcbiAgICByZXR1cm4gdGhpcy5oYW5kbGVyLmVsZW1lbnRcbiAgfVxuICBwcm90ZWN0ZWQgZW1pdHRlcjogRW1pdHRlcjx7XG4gICAgJ2RpZC1jaGFuZ2UtdGl0bGUnOiB1bmRlZmluZWRcbiAgICAnZGlkLWNoYW5nZS1tYXJrZG93bic6IHVuZGVmaW5lZFxuICB9PiA9IG5ldyBFbWl0dGVyKClcbiAgcHJvdGVjdGVkIGRpc3Bvc2FibGVzID0gbmV3IENvbXBvc2l0ZURpc3Bvc2FibGUoKVxuICBwcm90ZWN0ZWQgZGVzdHJveWVkID0gZmFsc2VcbiAgcHJpdmF0ZSBsb2FkaW5nOiBib29sZWFuID0gdHJ1ZVxuICBwcml2YXRlIGltYWdlV2F0Y2hlciE6IEltYWdlV2F0Y2hlclxuXG4gIHByb3RlY3RlZCBjb25zdHJ1Y3RvcihcbiAgICBwcml2YXRlIGRlZmF1bHRSZW5kZXJNb2RlOiBFeGNsdWRlPHJlbmRlcmVyLlJlbmRlck1vZGUsICdzYXZlJz4gPSAnbm9ybWFsJyxcbiAgICBwcml2YXRlIHJlbmRlckxhVGVYOiBib29sZWFuID0gYXRvbUNvbmZpZygpLm1hdGhDb25maWdcbiAgICAgIC5lbmFibGVMYXRleFJlbmRlcmluZ0J5RGVmYXVsdCxcbiAgKSB7XG4gICAgdGhpcy5yZW5kZXJQcm9taXNlID0gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgIHRoaXMuaGFuZGxlciA9IG5ldyBXZWJ2aWV3SGFuZGxlcigoKSA9PiB7XG4gICAgICAgIHRoaXMuaGFuZGxlci5pbml0KGF0b20uZ2V0Q29uZmlnRGlyUGF0aCgpLCBhdG9tQ29uZmlnKCkubWF0aENvbmZpZylcbiAgICAgICAgLy8gVE9ETzogb2JzZXJ2ZVxuICAgICAgICB0aGlzLmhhbmRsZXIuc2V0VXNlR2l0SHViU3R5bGUoXG4gICAgICAgICAgYXRvbS5jb25maWcuZ2V0KCdtYXJrZG93bi1wcmV2aWV3LXBsdXMudXNlR2l0SHViU3R5bGUnKSxcbiAgICAgICAgKVxuICAgICAgICB0aGlzLmhhbmRsZXIuc2V0QmFzZVBhdGgodGhpcy5nZXRQYXRoKCkpXG4gICAgICAgIHRoaXMuZW1pdHRlci5lbWl0KCdkaWQtY2hhbmdlLXRpdGxlJylcbiAgICAgICAgcmVzb2x2ZSh0aGlzLnJlbmRlck1hcmtkb3duKCkpXG4gICAgICB9KVxuICAgICAgdGhpcy5pbWFnZVdhdGNoZXIgPSBuZXcgSW1hZ2VXYXRjaGVyKFxuICAgICAgICB0aGlzLmhhbmRsZXIudXBkYXRlSW1hZ2VzLmJpbmQodGhpcy5oYW5kbGVyKSxcbiAgICAgIClcbiAgICAgIE1hcmtkb3duUHJldmlld1ZpZXcuZWxlbWVudE1hcC5zZXQodGhpcy5lbGVtZW50LCB0aGlzKVxuICAgIH0pXG4gICAgdGhpcy5ydW5KUyA9IHRoaXMuaGFuZGxlci5ydW5KUy5iaW5kKHRoaXMuaGFuZGxlcilcbiAgICB0aGlzLmhhbmRsZUV2ZW50cygpXG4gICAgdGhpcy5oYW5kbGVyLmVtaXR0ZXIub24oJ2RpZC1zY3JvbGwtcHJldmlldycsICh7IG1pbiwgbWF4IH0pID0+IHtcbiAgICAgIHRoaXMuZGlkU2Nyb2xsUHJldmlldyhtaW4sIG1heClcbiAgICB9KVxuICB9XG5cbiAgcHVibGljIHN0YXRpYyB2aWV3Rm9yRWxlbWVudChlbGVtZW50OiBIVE1MRWxlbWVudCkge1xuICAgIHJldHVybiBNYXJrZG93blByZXZpZXdWaWV3LmVsZW1lbnRNYXAuZ2V0KGVsZW1lbnQpXG4gIH1cblxuICBwdWJsaWMgYWJzdHJhY3Qgc2VyaWFsaXplKCk6IFNlcmlhbGl6ZWRNUFZcblxuICBwdWJsaWMgZGVzdHJveSgpIHtcbiAgICBpZiAodGhpcy5kZXN0cm95ZWQpIHJldHVyblxuICAgIHRoaXMuZGVzdHJveWVkID0gdHJ1ZVxuICAgIHRoaXMuaW1hZ2VXYXRjaGVyLmRpc3Bvc2UoKVxuICAgIHRoaXMuZGlzcG9zYWJsZXMuZGlzcG9zZSgpXG4gICAgdGhpcy5oYW5kbGVyLmRlc3Ryb3koKVxuICAgIE1hcmtkb3duUHJldmlld1ZpZXcuZWxlbWVudE1hcC5kZWxldGUodGhpcy5lbGVtZW50KVxuICB9XG5cbiAgcHVibGljIG9uRGlkQ2hhbmdlVGl0bGUoY2FsbGJhY2s6ICgpID0+IHZvaWQpOiBEaXNwb3NhYmxlIHtcbiAgICByZXR1cm4gdGhpcy5lbWl0dGVyLm9uKCdkaWQtY2hhbmdlLXRpdGxlJywgY2FsbGJhY2spXG4gIH1cblxuICBwdWJsaWMgb25EaWRDaGFuZ2VNYXJrZG93bihjYWxsYmFjazogKCkgPT4gdm9pZCk6IERpc3Bvc2FibGUge1xuICAgIHJldHVybiB0aGlzLmVtaXR0ZXIub24oJ2RpZC1jaGFuZ2UtbWFya2Rvd24nLCBjYWxsYmFjaylcbiAgfVxuXG4gIHB1YmxpYyB0b2dnbGVSZW5kZXJMYXRleCgpIHtcbiAgICB0aGlzLnJlbmRlckxhVGVYID0gIXRoaXMucmVuZGVyTGFUZVhcbiAgICB0aGlzLmNoYW5nZUhhbmRsZXIoKVxuICB9XG5cbiAgcHVibGljIGFic3RyYWN0IGdldFRpdGxlKCk6IHN0cmluZ1xuXG4gIHB1YmxpYyBnZXREZWZhdWx0TG9jYXRpb24oKTogJ2xlZnQnIHwgJ3JpZ2h0JyB8ICdib3R0b20nIHwgJ2NlbnRlcicge1xuICAgIHJldHVybiBhdG9tQ29uZmlnKCkucHJldmlld0NvbmZpZy5wcmV2aWV3RG9ja1xuICB9XG5cbiAgcHVibGljIGdldEljb25OYW1lKCkge1xuICAgIHJldHVybiAnbWFya2Rvd24nXG4gIH1cblxuICBwdWJsaWMgYWJzdHJhY3QgZ2V0VVJJKCk6IHN0cmluZ1xuXG4gIHB1YmxpYyBhYnN0cmFjdCBnZXRQYXRoKCk6IHN0cmluZyB8IHVuZGVmaW5lZFxuXG4gIHB1YmxpYyBnZXRTYXZlRGlhbG9nT3B0aW9ucygpIHtcbiAgICBsZXQgZGVmYXVsdFBhdGggPSB0aGlzLmdldFBhdGgoKVxuICAgIGlmIChkZWZhdWx0UGF0aCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBwcm9qZWN0UGF0aCA9IGF0b20ucHJvamVjdC5nZXRQYXRocygpWzBdXG4gICAgICBkZWZhdWx0UGF0aCA9ICd1bnRpdGxlZC5tZCdcbiAgICAgIGlmIChwcm9qZWN0UGF0aCkge1xuICAgICAgICBkZWZhdWx0UGF0aCA9IHBhdGguam9pbihwcm9qZWN0UGF0aCwgZGVmYXVsdFBhdGgpXG4gICAgICB9XG4gICAgfVxuICAgIGRlZmF1bHRQYXRoICs9ICcuJyArIGF0b21Db25maWcoKS5zYXZlQ29uZmlnLmRlZmF1bHRTYXZlRm9ybWF0XG4gICAgcmV0dXJuIHsgZGVmYXVsdFBhdGggfVxuICB9XG5cbiAgcHVibGljIHNhdmVBcyhmaWxlUGF0aDogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gICAgaWYgKGZpbGVQYXRoID09PSB1bmRlZmluZWQpIHJldHVyblxuICAgIGlmICh0aGlzLmxvYWRpbmcpIHRocm93IG5ldyBFcnJvcignUHJldmlldyBpcyBzdGlsbCBsb2FkaW5nJylcblxuICAgIGNvbnN0IHsgbmFtZSwgZXh0IH0gPSBwYXRoLnBhcnNlKGZpbGVQYXRoKVxuXG4gICAgaWYgKGV4dCA9PT0gJy5wZGYnKSB7XG4gICAgICB0aGlzLmhhbmRsZXIuc2F2ZVRvUERGKGZpbGVQYXRoKS5jYXRjaCgoZXJyb3I6IEVycm9yKSA9PiB7XG4gICAgICAgIGF0b20ubm90aWZpY2F0aW9ucy5hZGRFcnJvcignRmFpbGVkIHNhdmluZyB0byBQREYnLCB7XG4gICAgICAgICAgZGVzY3JpcHRpb246IGVycm9yLnRvU3RyaW5nKCksXG4gICAgICAgICAgZGlzbWlzc2FibGU6IHRydWUsXG4gICAgICAgICAgc3RhY2s6IGVycm9yLnN0YWNrLFxuICAgICAgICB9KVxuICAgICAgfSlcbiAgICB9IGVsc2Uge1xuICAgICAgaGFuZGxlUHJvbWlzZShcbiAgICAgICAgdGhpcy5nZXRIVE1MVG9TYXZlKGZpbGVQYXRoKS50aGVuKGFzeW5jIChodG1sKSA9PiB7XG4gICAgICAgICAgY29uc3QgZnVsbEh0bWwgPSB1dGlsLm1rSHRtbChcbiAgICAgICAgICAgIG5hbWUsXG4gICAgICAgICAgICBodG1sLFxuICAgICAgICAgICAgdGhpcy5yZW5kZXJMYVRlWCxcbiAgICAgICAgICAgIGF0b20uY29uZmlnLmdldCgnbWFya2Rvd24tcHJldmlldy1wbHVzLnVzZUdpdEh1YlN0eWxlJyksXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmhhbmRsZXIuZ2V0VGVYQ29uZmlnKCksXG4gICAgICAgICAgKVxuXG4gICAgICAgICAgZnMud3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgZnVsbEh0bWwpXG4gICAgICAgICAgcmV0dXJuIGF0b20ud29ya3NwYWNlLm9wZW4oZmlsZVBhdGgpXG4gICAgICAgIH0pLFxuICAgICAgKVxuICAgIH1cbiAgfVxuXG4gIHByb3RlY3RlZCBkaWRTY3JvbGxQcmV2aWV3KF9taW46IG51bWJlciwgX21heDogbnVtYmVyKSB7XG4gICAgLyogbm9vcCwgaW1wbGVtZW50YXRpb24gaW4gZWRpdG9yIHByZXZpZXcgKi9cbiAgfVxuXG4gIHByb3RlY3RlZCBjaGFuZ2VIYW5kbGVyID0gKCkgPT4ge1xuICAgIGhhbmRsZVByb21pc2UodGhpcy5yZW5kZXJNYXJrZG93bigpKVxuXG4gICAgY29uc3QgcGFuZSA9IGF0b20ud29ya3NwYWNlLnBhbmVGb3JJdGVtKHRoaXMpXG4gICAgaWYgKHBhbmUgIT09IHVuZGVmaW5lZCAmJiBwYW5lICE9PSBhdG9tLndvcmtzcGFjZS5nZXRBY3RpdmVQYW5lKCkpIHtcbiAgICAgIHBhbmUuYWN0aXZhdGVJdGVtKHRoaXMpXG4gICAgfVxuICB9XG5cbiAgcHJvdGVjdGVkIGFic3RyYWN0IGFzeW5jIGdldE1hcmtkb3duU291cmNlKCk6IFByb21pc2U8c3RyaW5nPlxuXG4gIHByb3RlY3RlZCBhYnN0cmFjdCBnZXRHcmFtbWFyKCk6IEdyYW1tYXIgfCB1bmRlZmluZWRcblxuICBwcm90ZWN0ZWQgb3BlblNvdXJjZShpbml0aWFsTGluZT86IG51bWJlcikge1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLmdldFBhdGgoKVxuICAgIGlmIChwYXRoID09PSB1bmRlZmluZWQpIHJldHVyblxuICAgIGhhbmRsZVByb21pc2UoXG4gICAgICBhdG9tLndvcmtzcGFjZS5vcGVuKHBhdGgsIHtcbiAgICAgICAgaW5pdGlhbExpbmUsXG4gICAgICAgIHNlYXJjaEFsbFBhbmVzOiB0cnVlLFxuICAgICAgfSksXG4gICAgKVxuICB9XG5cbiAgcHJvdGVjdGVkIHN5bmNQcmV2aWV3KGxpbmU6IG51bWJlciwgZmxhc2g6IGJvb2xlYW4pIHtcbiAgICB0aGlzLmhhbmRsZXIuc3luYyhsaW5lLCBmbGFzaClcbiAgfVxuXG4gIHByb3RlY3RlZCBvcGVuTmV3V2luZG93KCkge1xuICAgIGNvbnN0IHBhdGggPSB0aGlzLmdldFBhdGgoKVxuICAgIGlmICghcGF0aCkge1xuICAgICAgYXRvbS5ub3RpZmljYXRpb25zLmFkZFdhcm5pbmcoXG4gICAgICAgICdDYW4gbm90IG9wZW4gdGhpcyBwcmV2aWV3IGluIG5ldyB3aW5kb3c6IG5vIGZpbGUgcGF0aCcsXG4gICAgICApXG4gICAgICByZXR1cm5cbiAgICB9XG4gICAgYXRvbS5vcGVuKHtcbiAgICAgIHBhdGhzVG9PcGVuOiBbYG1hcmtkb3duLXByZXZpZXctcGx1czovL2ZpbGUvJHtwYXRofWBdLFxuICAgICAgbmV3V2luZG93OiB0cnVlLFxuICAgIH0pXG4gICAgdXRpbC5kZXN0cm95KHRoaXMpXG4gIH1cblxuICBwcml2YXRlIGhhbmRsZUV2ZW50cygpIHtcbiAgICB0aGlzLmRpc3Bvc2FibGVzLmFkZChcbiAgICAgIGF0b20uZ3JhbW1hcnMub25EaWRBZGRHcmFtbWFyKCgpID0+XG4gICAgICAgIGRlYm91bmNlKCgpID0+IHtcbiAgICAgICAgICBoYW5kbGVQcm9taXNlKHRoaXMucmVuZGVyTWFya2Rvd24oKSlcbiAgICAgICAgfSwgMjUwKSxcbiAgICAgICksXG4gICAgICBhdG9tLmdyYW1tYXJzLm9uRGlkVXBkYXRlR3JhbW1hcihcbiAgICAgICAgZGVib3VuY2UoKCkgPT4ge1xuICAgICAgICAgIGhhbmRsZVByb21pc2UodGhpcy5yZW5kZXJNYXJrZG93bigpKVxuICAgICAgICB9LCAyNTApLFxuICAgICAgKSxcbiAgICAgIGF0b20uY29tbWFuZHMuYWRkKHRoaXMuZWxlbWVudCwge1xuICAgICAgICAnY29yZTptb3ZlLXVwJzogKCkgPT4gdGhpcy5lbGVtZW50LnNjcm9sbEJ5KHsgdG9wOiAtMTAgfSksXG4gICAgICAgICdjb3JlOm1vdmUtZG93bic6ICgpID0+IHRoaXMuZWxlbWVudC5zY3JvbGxCeSh7IHRvcDogMTAgfSksXG4gICAgICAgICdjb3JlOmNvcHknOiAoKSA9PiB7XG4gICAgICAgICAgaGFuZGxlUHJvbWlzZSh0aGlzLmNvcHlUb0NsaXBib2FyZCgpKVxuICAgICAgICB9LFxuICAgICAgICAnbWFya2Rvd24tcHJldmlldy1wbHVzOm9wZW4tZGV2LXRvb2xzJzogKCkgPT4ge1xuICAgICAgICAgIHRoaXMuaGFuZGxlci5vcGVuRGV2VG9vbHMoKVxuICAgICAgICB9LFxuICAgICAgICAnbWFya2Rvd24tcHJldmlldy1wbHVzOm5ldy13aW5kb3cnOiAoKSA9PiB7XG4gICAgICAgICAgdGhpcy5vcGVuTmV3V2luZG93KClcbiAgICAgICAgfSxcbiAgICAgICAgJ21hcmtkb3duLXByZXZpZXctcGx1czpwcmludCc6ICgpID0+IHtcbiAgICAgICAgICB0aGlzLmhhbmRsZXIucHJpbnQoKVxuICAgICAgICB9LFxuICAgICAgICAnbWFya2Rvd24tcHJldmlldy1wbHVzOnpvb20taW4nOiAoKSA9PiB7XG4gICAgICAgICAgdGhpcy5oYW5kbGVyLnpvb21JbigpXG4gICAgICAgIH0sXG4gICAgICAgICdtYXJrZG93bi1wcmV2aWV3LXBsdXM6em9vbS1vdXQnOiAoKSA9PiB7XG4gICAgICAgICAgdGhpcy5oYW5kbGVyLnpvb21PdXQoKVxuICAgICAgICB9LFxuICAgICAgICAnbWFya2Rvd24tcHJldmlldy1wbHVzOnJlc2V0LXpvb20nOiAoKSA9PiB7XG4gICAgICAgICAgdGhpcy5oYW5kbGVyLnJlc2V0Wm9vbSgpXG4gICAgICAgIH0sXG4gICAgICAgICdtYXJrZG93bi1wcmV2aWV3LXBsdXM6c3luYy1zb3VyY2UnOiBhc3luYyAoX2V2ZW50KSA9PiB7XG4gICAgICAgICAgY29uc3QgbGluZSA9IGF3YWl0IHRoaXMuaGFuZGxlci5zeW5jU291cmNlKClcbiAgICAgICAgICB0aGlzLm9wZW5Tb3VyY2UobGluZSlcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgYXRvbS5jb25maWcub25EaWRDaGFuZ2UoJ21hcmtkb3duLXByZXZpZXctcGx1cy5tYXJrZG93bkl0Q29uZmlnJywgKCkgPT4ge1xuICAgICAgICBpZiAoYXRvbUNvbmZpZygpLnJlbmRlcmVyID09PSAnbWFya2Rvd24taXQnKSB0aGlzLmNoYW5nZUhhbmRsZXIoKVxuICAgICAgfSksXG4gICAgICBhdG9tLmNvbmZpZy5vbkRpZENoYW5nZSgnbWFya2Rvd24tcHJldmlldy1wbHVzLnBhbmRvY0NvbmZpZycsICgpID0+IHtcbiAgICAgICAgaWYgKGF0b21Db25maWcoKS5yZW5kZXJlciA9PT0gJ3BhbmRvYycpIHRoaXMuY2hhbmdlSGFuZGxlcigpXG4gICAgICB9KSxcbiAgICAgIGF0b20uY29uZmlnLm9uRGlkQ2hhbmdlKFxuICAgICAgICAnbWFya2Rvd24tcHJldmlldy1wbHVzLm1hdGhDb25maWcubGF0ZXhSZW5kZXJlcicsXG4gICAgICAgICgpID0+IHtcbiAgICAgICAgICBoYW5kbGVQcm9taXNlKHRoaXMuaGFuZGxlci5yZWxvYWQoKSlcbiAgICAgICAgfSxcbiAgICAgICksXG4gICAgICBhdG9tLmNvbmZpZy5vbkRpZENoYW5nZShcbiAgICAgICAgJ21hcmtkb3duLXByZXZpZXctcGx1cy5tYXRoQ29uZmlnLm51bWJlckVxdWF0aW9ucycsXG4gICAgICAgICgpID0+IHtcbiAgICAgICAgICBoYW5kbGVQcm9taXNlKHRoaXMuaGFuZGxlci5yZWxvYWQoKSlcbiAgICAgICAgfSxcbiAgICAgICksXG4gICAgICBhdG9tLmNvbmZpZy5vbkRpZENoYW5nZShcbiAgICAgICAgJ21hcmtkb3duLXByZXZpZXctcGx1cy5yZW5kZXJlcicsXG4gICAgICAgIHRoaXMuY2hhbmdlSGFuZGxlcixcbiAgICAgICksXG4gICAgICBhdG9tLmNvbmZpZy5vbkRpZENoYW5nZShcbiAgICAgICAgJ21hcmtkb3duLXByZXZpZXctcGx1cy51c2VHaXRIdWJTdHlsZScsXG4gICAgICAgICh7IG5ld1ZhbHVlIH0pID0+IHtcbiAgICAgICAgICB0aGlzLmhhbmRsZXIuc2V0VXNlR2l0SHViU3R5bGUobmV3VmFsdWUpXG4gICAgICAgIH0sXG4gICAgICApLFxuICAgIClcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVuZGVyTWFya2Rvd24oKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3Qgc291cmNlID0gYXdhaXQgdGhpcy5nZXRNYXJrZG93blNvdXJjZSgpXG4gICAgYXdhaXQgdGhpcy5yZW5kZXJNYXJrZG93blRleHQoc291cmNlKVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBnZXRIVE1MVG9TYXZlKHNhdmVQYXRoOiBzdHJpbmcpIHtcbiAgICBjb25zdCBzb3VyY2UgPSBhd2FpdCB0aGlzLmdldE1hcmtkb3duU291cmNlKClcbiAgICByZXR1cm4gcmVuZGVyZXIucmVuZGVyKHtcbiAgICAgIHRleHQ6IHNvdXJjZSxcbiAgICAgIGZpbGVQYXRoOiB0aGlzLmdldFBhdGgoKSxcbiAgICAgIGdyYW1tYXI6IHRoaXMuZ2V0R3JhbW1hcigpLFxuICAgICAgcmVuZGVyTGFUZVg6IHRoaXMucmVuZGVyTGFUZVgsXG4gICAgICBtb2RlOiAnc2F2ZScsXG4gICAgICBzYXZlUGF0aCxcbiAgICB9KVxuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZW5kZXJNYXJrZG93blRleHQodGV4dDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRvbURvY3VtZW50ID0gYXdhaXQgcmVuZGVyZXIucmVuZGVyKHtcbiAgICAgICAgdGV4dCxcbiAgICAgICAgZmlsZVBhdGg6IHRoaXMuZ2V0UGF0aCgpLFxuICAgICAgICBncmFtbWFyOiB0aGlzLmdldEdyYW1tYXIoKSxcbiAgICAgICAgcmVuZGVyTGFUZVg6IHRoaXMucmVuZGVyTGFUZVgsXG4gICAgICAgIG1vZGU6IHRoaXMuZGVmYXVsdFJlbmRlck1vZGUsXG4gICAgICAgIGltYWdlV2F0Y2hlcjogdGhpcy5pbWFnZVdhdGNoZXIsXG4gICAgICB9KVxuXG4gICAgICBpZiAodGhpcy5kZXN0cm95ZWQpIHJldHVyblxuICAgICAgdGhpcy5sb2FkaW5nID0gZmFsc2VcbiAgICAgIGhhbmRsZVByb21pc2UoXG4gICAgICAgIHRoaXMuaGFuZGxlci51cGRhdGUoXG4gICAgICAgICAgZG9tRG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50Lm91dGVySFRNTCxcbiAgICAgICAgICB0aGlzLnJlbmRlckxhVGVYLFxuICAgICAgICApLFxuICAgICAgKVxuICAgICAgdGhpcy5oYW5kbGVyLnNldFNvdXJjZU1hcChcbiAgICAgICAgdXRpbC5idWlsZExpbmVNYXAobWFya2Rvd25JdC5nZXRUb2tlbnModGV4dCwgdGhpcy5yZW5kZXJMYVRlWCkpLFxuICAgICAgKVxuICAgICAgdGhpcy5lbWl0dGVyLmVtaXQoJ2RpZC1jaGFuZ2UtbWFya2Rvd24nKVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICB0aGlzLnNob3dFcnJvcihlcnJvciBhcyBFcnJvcilcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHNob3dFcnJvcihlcnJvcjogRXJyb3IpIHtcbiAgICBpZiAodGhpcy5kZXN0cm95ZWQpIHtcbiAgICAgIGF0b20ubm90aWZpY2F0aW9ucy5hZGRGYXRhbEVycm9yKFxuICAgICAgICAnRXJyb3IgcmVwb3J0ZWQgb24gYSBkZXN0cm95ZWQgTWFya2Rvd24gUHJldmlldyBQbHVzIHZpZXcnLFxuICAgICAgICB7XG4gICAgICAgICAgZGlzbWlzc2FibGU6IHRydWUsXG4gICAgICAgICAgc3RhY2s6IGVycm9yLnN0YWNrLFxuICAgICAgICAgIGRldGFpbDogZXJyb3IubWVzc2FnZSxcbiAgICAgICAgfSxcbiAgICAgIClcbiAgICAgIHJldHVyblxuICAgIH1cbiAgICB0aGlzLmhhbmRsZXIuZXJyb3IoZXJyb3IubWVzc2FnZSlcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgY29weVRvQ2xpcGJvYXJkKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IHRoaXMucmVuZGVyUHJvbWlzZVxuICAgIGNvbnN0IHNlbGVjdGlvbiA9IGF3YWl0IHRoaXMuaGFuZGxlci5nZXRTZWxlY3Rpb24oKVxuICAgIC8vIFVzZSBkZWZhdWx0IGNvcHkgZXZlbnQgaGFuZGxlciBpZiB0aGVyZSBpcyBzZWxlY3RlZCB0ZXh0IGluc2lkZSB0aGlzIHZpZXdcbiAgICBpZiAoc2VsZWN0aW9uICE9PSB1bmRlZmluZWQpIHJldHVyblxuICAgIGNvbnN0IHNyYyA9IGF3YWl0IHRoaXMuZ2V0TWFya2Rvd25Tb3VyY2UoKVxuICAgIGF3YWl0IGNvcHlIdG1sKHNyYywgdGhpcy5nZXRQYXRoKCksIHRoaXMucmVuZGVyTGFUZVgpXG4gIH1cbn1cbiJdfQ==