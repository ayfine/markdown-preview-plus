"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const atom_1 = require("atom");
const electron_1 = require("electron");
const fileUriToPath = require("file-uri-to-path");
const util_1 = require("../util");
class WebviewHandler {
    constructor(init) {
        this.emitter = new atom_1.Emitter();
        this.disposables = new atom_1.CompositeDisposable();
        this.destroyed = false;
        this.zoomLevel = 0;
        this.replyCallbacks = new Map();
        this.replyCallbackId = 0;
        this._element = document.createElement('webview');
        this._element.classList.add('markdown-preview-plus', 'native-key-bindings');
        this._element.disablewebsecurity = 'true';
        this._element.nodeintegration = 'true';
        this._element.src = `file:///${__dirname}/../../client/template.html`;
        this._element.style.width = '100%';
        this._element.style.height = '100%';
        this._element.addEventListener('ipc-message', (e) => {
            switch (e.channel) {
                case 'zoom-in':
                    this.zoomIn();
                    break;
                case 'zoom-out':
                    this.zoomOut();
                    break;
                case 'did-scroll-preview':
                    this.emitter.emit('did-scroll-preview', e.args[0]);
                    break;
                case 'request-reply': {
                    const { id, request, result } = e.args[0];
                    const cb = this.replyCallbacks.get(id);
                    if (cb && request === cb.request) {
                        const callback = cb.callback;
                        callback(result);
                    }
                    break;
                }
            }
        });
        this._element.addEventListener('will-navigate', async (e) => {
            const exts = util_1.atomConfig().previewConfig.shellOpenFileExtensions;
            const forceOpenExternal = exts.some((ext) => e.url.toLowerCase().endsWith(`.${ext.toLowerCase()}`));
            if (e.url.startsWith('file://') && !forceOpenExternal) {
                util_1.handlePromise(atom.workspace.open(fileUriToPath(e.url)));
            }
            else {
                electron_1.shell.openExternal(e.url);
            }
        });
        this.disposables.add(atom.styles.onDidAddStyleElement(() => {
            this.updateStyles();
        }), atom.styles.onDidRemoveStyleElement(() => {
            this.updateStyles();
        }), atom.styles.onDidUpdateStyleElement(() => {
            this.updateStyles();
        }));
        const onload = () => {
            if (this.destroyed)
                return;
            this._element.setZoomLevel(this.zoomLevel);
            this.updateStyles();
            init();
        };
        this._element.addEventListener('dom-ready', onload);
    }
    get element() {
        return this._element;
    }
    async runJS(js) {
        return new Promise((resolve) => this._element.executeJavaScript(js, false, resolve));
    }
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.disposables.dispose();
        this._element.remove();
    }
    async update(html, renderLaTeX) {
        if (this.destroyed)
            return undefined;
        return this.runRequest('update-preview', {
            html,
            renderLaTeX,
        });
    }
    setSourceMap(map) {
        this._element.send('set-source-map', { map });
    }
    setUseGitHubStyle(value) {
        this._element.send('use-github-style', { value });
    }
    setBasePath(path) {
        this._element.send('set-base-path', { path });
    }
    init(atomHome, mathJaxConfig, mathJaxRenderer = util_1.atomConfig().mathConfig.latexRenderer) {
        this._element.send('init', {
            atomHome,
            mathJaxConfig,
            mathJaxRenderer,
        });
    }
    updateImages(oldSource, version) {
        this._element.send('update-images', {
            oldsrc: oldSource,
            v: version,
        });
    }
    async saveToPDF(filePath) {
        const opts = util_1.atomConfig().saveConfig.saveToPDFOptions;
        const customPageSize = parsePageSize(opts.customPageSize);
        const pageSize = opts.pageSize === 'Custom' ? customPageSize : opts.pageSize;
        if (pageSize === undefined) {
            throw new Error(`Failed to parse custom page size: ${opts.customPageSize}`);
        }
        const selection = await this.getSelection();
        const printSelectionOnly = selection ? opts.printSelectionOnly : false;
        const newOpts = Object.assign({}, opts, { pageSize,
            printSelectionOnly });
        await this.prepareSaveToPDF(newOpts);
        try {
            const data = await new Promise((resolve, reject) => {
                this._element.printToPDF(newOpts, (error, data) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve(data);
                });
            });
            await new Promise((resolve, reject) => {
                fs.writeFile(filePath, data, (error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        }
        finally {
            util_1.handlePromise(this.finishSaveToPDF());
        }
    }
    sync(line, flash) {
        this._element.send('sync', { line, flash });
    }
    async syncSource() {
        return this.runRequest('sync-source', {});
    }
    scrollSync(firstLine, lastLine) {
        this._element.send('scroll-sync', { firstLine, lastLine });
    }
    zoomIn() {
        this.zoomLevel += 0.1;
        this._element.setZoomLevel(this.zoomLevel);
    }
    zoomOut() {
        this.zoomLevel -= 0.1;
        this._element.setZoomLevel(this.zoomLevel);
    }
    resetZoom() {
        this.zoomLevel = 0;
        this._element.setZoomLevel(this.zoomLevel);
    }
    print() {
        this._element.print();
    }
    openDevTools() {
        this._element.openDevTools();
    }
    async reload() {
        await this.runRequest('reload', {});
        this._element.reload();
    }
    error(msg) {
        this._element.send('error', { msg });
    }
    async getTeXConfig() {
        return this.runRequest('get-tex-config', {});
    }
    async getSelection() {
        return this.runRequest('get-selection', {});
    }
    async runRequest(request, args) {
        const id = this.replyCallbackId++;
        return new Promise((resolve) => {
            this.replyCallbacks.set(id, {
                request: request,
                callback: (result) => {
                    this.replyCallbacks.delete(id);
                    resolve(result);
                },
            });
            const newargs = Object.assign({ id }, args);
            this._element.send(request, newargs);
        });
    }
    async prepareSaveToPDF(opts) {
        const [width, height] = getPageWidth(opts.pageSize);
        return this.runRequest('set-width', {
            width: opts.landscape ? height : width,
        });
    }
    async finishSaveToPDF() {
        return this.runRequest('set-width', { width: undefined });
    }
    updateStyles() {
        const styles = [];
        for (const se of atom.styles.getStyleElements()) {
            styles.push(se.innerHTML);
        }
        this._element.send('style', { styles });
    }
}
exports.WebviewHandler = WebviewHandler;
function parsePageSize(size) {
    if (!size)
        return undefined;
    const rx = /^([\d.,]+)(cm|mm|in)?x([\d.,]+)(cm|mm|in)?$/i;
    const res = size.replace(/\s*/g, '').match(rx);
    if (res) {
        const width = parseFloat(res[1]);
        const wunit = res[2];
        const height = parseFloat(res[3]);
        const hunit = res[4];
        return {
            width: convert(width, wunit),
            height: convert(height, hunit),
        };
    }
    else {
        return undefined;
    }
}
function convert(val, unit) {
    return val * unitInMicrons(unit);
}
function unitInMicrons(unit = 'mm') {
    switch (unit) {
        case 'mm':
            return 1000;
        case 'cm':
            return 10000;
        case 'in':
            return 25400;
    }
}
function getPageWidth(pageSize) {
    switch (pageSize) {
        case 'A3':
            return [297, 420];
        case 'A4':
            return [210, 297];
        case 'A5':
            return [148, 210];
        case 'Legal':
            return [216, 356];
        case 'Letter':
            return [216, 279];
        case 'Tabloid':
            return [279, 432];
        default:
            return [pageSize.width / 1000, pageSize.height / 1000];
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2Vidmlldy1oYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vc3JjL21hcmtkb3duLXByZXZpZXctdmlldy93ZWJ2aWV3LWhhbmRsZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSx5QkFBd0I7QUFDeEIsK0JBQWlFO0FBQ2pFLHVDQUE0QztBQUM1QyxrREFBa0Q7QUFFbEQsa0NBQW1EO0FBWW5ELE1BQWEsY0FBYztJQWN6QixZQUFZLElBQWdCO1FBYlosWUFBTyxHQUFHLElBQUksY0FBTyxFQUtsQyxDQUFBO1FBQ08sZ0JBQVcsR0FBRyxJQUFJLDBCQUFtQixFQUFFLENBQUE7UUFFekMsY0FBUyxHQUFHLEtBQUssQ0FBQTtRQUNqQixjQUFTLEdBQUcsQ0FBQyxDQUFBO1FBQ2IsbUJBQWMsR0FBRyxJQUFJLEdBQUcsRUFBK0IsQ0FBQTtRQUN2RCxvQkFBZSxHQUFHLENBQUMsQ0FBQTtRQUd6QixJQUFJLENBQUMsUUFBUSxHQUFHLFFBQVEsQ0FBQyxhQUFhLENBQUMsU0FBUyxDQUFDLENBQUE7UUFDakQsSUFBSSxDQUFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLHVCQUF1QixFQUFFLHFCQUFxQixDQUFDLENBQUE7UUFDM0UsSUFBSSxDQUFDLFFBQVEsQ0FBQyxrQkFBa0IsR0FBRyxNQUFNLENBQUE7UUFDekMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxlQUFlLEdBQUcsTUFBTSxDQUFBO1FBQ3RDLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxHQUFHLFdBQVcsU0FBUyw2QkFBNkIsQ0FBQTtRQUNyRSxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxLQUFLLEdBQUcsTUFBTSxDQUFBO1FBQ2xDLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLE1BQU0sR0FBRyxNQUFNLENBQUE7UUFDbkMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxnQkFBZ0IsQ0FDNUIsYUFBYSxFQUNiLENBQUMsQ0FBaUMsRUFBRSxF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Q0FBQyxDQUFBO0FBQ2xDLENBQUM7QUFFRCxTQUFTLGFBQWEsQ0FBQyxPQUFhLElBQUk7SUFDdEMsUUFBUSxJQUFJLEVBQUU7UUFDWixLQUFLLElBQUk7WUFDUCxPQUFPLElBQUksQ0FBQTtRQUNiLEtBQUssSUFBSTtZQUNQLE9BQU8sS0FBSyxDQUFBO1FBQ2QsS0FBSyxJQUFJO1lBQ1AsT0FBTyxLQUFLLENBQUE7S0FDZjtBQUNILENBQUM7QUFFRCxTQUFTLFlBQVksQ0FBQyxRQUFrQjtJQUN0QyxRQUFRLFFBQVEsRUFBRTtRQUNoQixLQUFLLElBQUk7WUFDUCxPQUFPLENBQUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxDQUFBO1FBQ25CLEtBQUssSUFBSTtZQUNQLE9BQU8sQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLENBQUE7UUFDbkIsS0FBSyxJQUFJO1lBQ1AsT0FBTyxDQUFDLEdBQUcsRUFBRSxHQUFHLENBQUMsQ0FBQTtRQUNuQixLQUFLLE9BQU87WUFDVixPQUFPLENBQUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxDQUFBO1FBQ25CLEtBQUssUUFBUTtZQUNYLE9BQU8sQ0FBQyxHQUFHLEVBQUUsR0FBRyxDQUFDLENBQUE7UUFDbkIsS0FBSyxTQUFTO1lBQ1osT0FBTyxDQUFDLEdBQUcsRUFBRSxHQUFHLENBQUMsQ0FBQTtRQUNuQjtZQUNFLE9BQU8sQ0FBQyxRQUFRLENBQUMsS0FBSyxHQUFHLElBQUksRUFBRSxRQUFRLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxDQUFBO0tBQ3pEO0FBQ0gsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGZzIGZyb20gJ2ZzJ1xuaW1wb3J0IHsgRW1pdHRlciwgQ29tcG9zaXRlRGlzcG9zYWJsZSwgQ29uZmlnVmFsdWVzIH0gZnJvbSAnYXRvbSdcbmltcG9ydCB7IFdlYnZpZXdUYWcsIHNoZWxsIH0gZnJvbSAnZWxlY3Ryb24nXG5pbXBvcnQgZmlsZVVyaVRvUGF0aCA9IHJlcXVpcmUoJ2ZpbGUtdXJpLXRvLXBhdGgnKVxuXG5pbXBvcnQgeyBoYW5kbGVQcm9taXNlLCBhdG9tQ29uZmlnIH0gZnJvbSAnLi4vdXRpbCdcbmltcG9ydCB7IFJlcXVlc3RSZXBseU1hcCwgQ2hhbm5lbE1hcCB9IGZyb20gJy4uLy4uL3NyYy1jbGllbnQvaXBjJ1xuXG5leHBvcnQgdHlwZSBSZXBseUNhbGxiYWNrU3RydWN0PFxuICBUIGV4dGVuZHMga2V5b2YgUmVxdWVzdFJlcGx5TWFwID0ga2V5b2YgUmVxdWVzdFJlcGx5TWFwXG4+ID0ge1xuICBbSyBpbiBrZXlvZiBSZXF1ZXN0UmVwbHlNYXBdOiB7XG4gICAgcmVxdWVzdDogS1xuICAgIGNhbGxiYWNrOiAocmVwbHk6IFJlcXVlc3RSZXBseU1hcFtLXSkgPT4gdm9pZFxuICB9XG59W1RdXG5cbmV4cG9ydCBjbGFzcyBXZWJ2aWV3SGFuZGxlciB7XG4gIHB1YmxpYyByZWFkb25seSBlbWl0dGVyID0gbmV3IEVtaXR0ZXI8XG4gICAge30sXG4gICAge1xuICAgICAgJ2RpZC1zY3JvbGwtcHJldmlldyc6IHsgbWluOiBudW1iZXI7IG1heDogbnVtYmVyIH1cbiAgICB9XG4gID4oKVxuICBwcm90ZWN0ZWQgZGlzcG9zYWJsZXMgPSBuZXcgQ29tcG9zaXRlRGlzcG9zYWJsZSgpXG4gIHByaXZhdGUgcmVhZG9ubHkgX2VsZW1lbnQ6IFdlYnZpZXdUYWdcbiAgcHJpdmF0ZSBkZXN0cm95ZWQgPSBmYWxzZVxuICBwcml2YXRlIHpvb21MZXZlbCA9IDBcbiAgcHJpdmF0ZSByZXBseUNhbGxiYWNrcyA9IG5ldyBNYXA8bnVtYmVyLCBSZXBseUNhbGxiYWNrU3RydWN0PigpXG4gIHByaXZhdGUgcmVwbHlDYWxsYmFja0lkID0gMFxuXG4gIGNvbnN0cnVjdG9yKGluaXQ6ICgpID0+IHZvaWQpIHtcbiAgICB0aGlzLl9lbGVtZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnd2VidmlldycpXG4gICAgdGhpcy5fZWxlbWVudC5jbGFzc0xpc3QuYWRkKCdtYXJrZG93bi1wcmV2aWV3LXBsdXMnLCAnbmF0aXZlLWtleS1iaW5kaW5ncycpXG4gICAgdGhpcy5fZWxlbWVudC5kaXNhYmxld2Vic2VjdXJpdHkgPSAndHJ1ZSdcbiAgICB0aGlzLl9lbGVtZW50Lm5vZGVpbnRlZ3JhdGlvbiA9ICd0cnVlJ1xuICAgIHRoaXMuX2VsZW1lbnQuc3JjID0gYGZpbGU6Ly8vJHtfX2Rpcm5hbWV9Ly4uLy4uL2NsaWVudC90ZW1wbGF0ZS5odG1sYFxuICAgIHRoaXMuX2VsZW1lbnQuc3R5bGUud2lkdGggPSAnMTAwJSdcbiAgICB0aGlzLl9lbGVtZW50LnN0eWxlLmhlaWdodCA9ICcxMDAlJ1xuICAgIHRoaXMuX2VsZW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcbiAgICAgICdpcGMtbWVzc2FnZScsXG4gICAgICAoZTogRWxlY3Ryb24uSXBjTWVzc2FnZUV2ZW50Q3VzdG9tKSA9PiB7XG4gICAgICAgIHN3aXRjaCAoZS5jaGFubmVsKSB7XG4gICAgICAgICAgY2FzZSAnem9vbS1pbic6XG4gICAgICAgICAgICB0aGlzLnpvb21JbigpXG4gICAgICAgICAgICBicmVha1xuICAgICAgICAgIGNhc2UgJ3pvb20tb3V0JzpcbiAgICAgICAgICAgIHRoaXMuem9vbU91dCgpXG4gICAgICAgICAgICBicmVha1xuICAgICAgICAgIGNhc2UgJ2RpZC1zY3JvbGwtcHJldmlldyc6XG4gICAgICAgICAgICB0aGlzLmVtaXR0ZXIuZW1pdCgnZGlkLXNjcm9sbC1wcmV2aWV3JywgZS5hcmdzWzBdKVxuICAgICAgICAgICAgYnJlYWtcbiAgICAgICAgICAvLyByZXBsaWVzXG4gICAgICAgICAgY2FzZSAncmVxdWVzdC1yZXBseSc6IHtcbiAgICAgICAgICAgIGNvbnN0IHsgaWQsIHJlcXVlc3QsIHJlc3VsdCB9ID0gZS5hcmdzWzBdXG4gICAgICAgICAgICBjb25zdCBjYiA9IHRoaXMucmVwbHlDYWxsYmFja3MuZ2V0KGlkKVxuICAgICAgICAgICAgaWYgKGNiICYmIHJlcXVlc3QgPT09IGNiLnJlcXVlc3QpIHtcbiAgICAgICAgICAgICAgY29uc3QgY2FsbGJhY2s6IChyOiBhbnkpID0+IHZvaWQgPSBjYi5jYWxsYmFja1xuICAgICAgICAgICAgICBjYWxsYmFjayhyZXN1bHQpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBicmVha1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSxcbiAgICApXG4gICAgdGhpcy5fZWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCd3aWxsLW5hdmlnYXRlJywgYXN5bmMgKGUpID0+IHtcbiAgICAgIGNvbnN0IGV4dHMgPSBhdG9tQ29uZmlnKCkucHJldmlld0NvbmZpZy5zaGVsbE9wZW5GaWxlRXh0ZW5zaW9uc1xuICAgICAgY29uc3QgZm9yY2VPcGVuRXh0ZXJuYWwgPSBleHRzLnNvbWUoKGV4dCkgPT5cbiAgICAgICAgZS51cmwudG9Mb3dlckNhc2UoKS5lbmRzV2l0aChgLiR7ZXh0LnRvTG93ZXJDYXNlKCl9YCksXG4gICAgICApXG4gICAgICBpZiAoZS51cmwuc3RhcnRzV2l0aCgnZmlsZTovLycpICYmICFmb3JjZU9wZW5FeHRlcm5hbCkge1xuICAgICAgICBoYW5kbGVQcm9taXNlKGF0b20ud29ya3NwYWNlLm9wZW4oZmlsZVVyaVRvUGF0aChlLnVybCkpKVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc2hlbGwub3BlbkV4dGVybmFsKGUudXJsKVxuICAgICAgfVxuICAgIH0pXG5cbiAgICB0aGlzLmRpc3Bvc2FibGVzLmFkZChcbiAgICAgIGF0b20uc3R5bGVzLm9uRGlkQWRkU3R5bGVFbGVtZW50KCgpID0+IHtcbiAgICAgICAgdGhpcy51cGRhdGVTdHlsZXMoKVxuICAgICAgfSksXG4gICAgICBhdG9tLnN0eWxlcy5vbkRpZFJlbW92ZVN0eWxlRWxlbWVudCgoKSA9PiB7XG4gICAgICAgIHRoaXMudXBkYXRlU3R5bGVzKClcbiAgICAgIH0pLFxuICAgICAgYXRvbS5zdHlsZXMub25EaWRVcGRhdGVTdHlsZUVsZW1lbnQoKCkgPT4ge1xuICAgICAgICB0aGlzLnVwZGF0ZVN0eWxlcygpXG4gICAgICB9KSxcbiAgICApXG5cbiAgICBjb25zdCBvbmxvYWQgPSAoKSA9PiB7XG4gICAgICBpZiAodGhpcy5kZXN0cm95ZWQpIHJldHVyblxuICAgICAgdGhpcy5fZWxlbWVudC5zZXRab29tTGV2ZWwodGhpcy56b29tTGV2ZWwpXG4gICAgICB0aGlzLnVwZGF0ZVN0eWxlcygpXG4gICAgICBpbml0KClcbiAgICB9XG4gICAgdGhpcy5fZWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCdkb20tcmVhZHknLCBvbmxvYWQpXG4gIH1cblxuICBwdWJsaWMgZ2V0IGVsZW1lbnQoKTogSFRNTEVsZW1lbnQge1xuICAgIHJldHVybiB0aGlzLl9lbGVtZW50XG4gIH1cblxuICBwdWJsaWMgYXN5bmMgcnVuSlM8VD4oanM6IHN0cmluZykge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZTxUPigocmVzb2x2ZSkgPT5cbiAgICAgIHRoaXMuX2VsZW1lbnQuZXhlY3V0ZUphdmFTY3JpcHQoanMsIGZhbHNlLCByZXNvbHZlKSxcbiAgICApXG4gIH1cblxuICBwdWJsaWMgZGVzdHJveSgpIHtcbiAgICBpZiAodGhpcy5kZXN0cm95ZWQpIHJldHVyblxuICAgIHRoaXMuZGVzdHJveWVkID0gdHJ1ZVxuICAgIHRoaXMuZGlzcG9zYWJsZXMuZGlzcG9zZSgpXG4gICAgdGhpcy5fZWxlbWVudC5yZW1vdmUoKVxuICB9XG5cbiAgcHVibGljIGFzeW5jIHVwZGF0ZShodG1sOiBzdHJpbmcsIHJlbmRlckxhVGVYOiBib29sZWFuKSB7XG4gICAgaWYgKHRoaXMuZGVzdHJveWVkKSByZXR1cm4gdW5kZWZpbmVkXG4gICAgcmV0dXJuIHRoaXMucnVuUmVxdWVzdCgndXBkYXRlLXByZXZpZXcnLCB7XG4gICAgICBodG1sLFxuICAgICAgcmVuZGVyTGFUZVgsXG4gICAgfSlcbiAgfVxuXG4gIHB1YmxpYyBzZXRTb3VyY2VNYXAobWFwOiB7XG4gICAgW2xpbmU6IG51bWJlcl06IHsgdGFnOiBzdHJpbmc7IGluZGV4OiBudW1iZXIgfVtdXG4gIH0pIHtcbiAgICB0aGlzLl9lbGVtZW50LnNlbmQ8J3NldC1zb3VyY2UtbWFwJz4oJ3NldC1zb3VyY2UtbWFwJywgeyBtYXAgfSlcbiAgfVxuXG4gIHB1YmxpYyBzZXRVc2VHaXRIdWJTdHlsZSh2YWx1ZTogYm9vbGVhbikge1xuICAgIHRoaXMuX2VsZW1lbnQuc2VuZDwndXNlLWdpdGh1Yi1zdHlsZSc+KCd1c2UtZ2l0aHViLXN0eWxlJywgeyB2YWx1ZSB9KVxuICB9XG5cbiAgcHVibGljIHNldEJhc2VQYXRoKHBhdGg/OiBzdHJpbmcpIHtcbiAgICB0aGlzLl9lbGVtZW50LnNlbmQ8J3NldC1iYXNlLXBhdGgnPignc2V0LWJhc2UtcGF0aCcsIHsgcGF0aCB9KVxuICB9XG5cbiAgcHVibGljIGluaXQoXG4gICAgYXRvbUhvbWU6IHN0cmluZyxcbiAgICBtYXRoSmF4Q29uZmlnOiBNYXRoSmF4Q29uZmlnLFxuICAgIG1hdGhKYXhSZW5kZXJlciA9IGF0b21Db25maWcoKS5tYXRoQ29uZmlnLmxhdGV4UmVuZGVyZXIsXG4gICkge1xuICAgIHRoaXMuX2VsZW1lbnQuc2VuZDwnaW5pdCc+KCdpbml0Jywge1xuICAgICAgYXRvbUhvbWUsXG4gICAgICBtYXRoSmF4Q29uZmlnLFxuICAgICAgbWF0aEpheFJlbmRlcmVyLFxuICAgIH0pXG4gIH1cblxuICBwdWJsaWMgdXBkYXRlSW1hZ2VzKG9sZFNvdXJjZTogc3RyaW5nLCB2ZXJzaW9uOiBudW1iZXIgfCB1bmRlZmluZWQpIHtcbiAgICB0aGlzLl9lbGVtZW50LnNlbmQ8J3VwZGF0ZS1pbWFnZXMnPigndXBkYXRlLWltYWdlcycsIHtcbiAgICAgIG9sZHNyYzogb2xkU291cmNlLFxuICAgICAgdjogdmVyc2lvbixcbiAgICB9KVxuICB9XG5cbiAgcHVibGljIGFzeW5jIHNhdmVUb1BERihmaWxlUGF0aDogc3RyaW5nKSB7XG4gICAgY29uc3Qgb3B0cyA9IGF0b21Db25maWcoKS5zYXZlQ29uZmlnLnNhdmVUb1BERk9wdGlvbnNcbiAgICBjb25zdCBjdXN0b21QYWdlU2l6ZSA9IHBhcnNlUGFnZVNpemUob3B0cy5jdXN0b21QYWdlU2l6ZSlcbiAgICBjb25zdCBwYWdlU2l6ZSA9IG9wdHMucGFnZVNpemUgPT09ICdDdXN0b20nID8gY3VzdG9tUGFnZVNpemUgOiBvcHRzLnBhZ2VTaXplXG4gICAgaWYgKHBhZ2VTaXplID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEZhaWxlZCB0byBwYXJzZSBjdXN0b20gcGFnZSBzaXplOiAke29wdHMuY3VzdG9tUGFnZVNpemV9YCxcbiAgICAgIClcbiAgICB9XG4gICAgY29uc3Qgc2VsZWN0aW9uID0gYXdhaXQgdGhpcy5nZXRTZWxlY3Rpb24oKVxuICAgIGNvbnN0IHByaW50U2VsZWN0aW9uT25seSA9IHNlbGVjdGlvbiA/IG9wdHMucHJpbnRTZWxlY3Rpb25Pbmx5IDogZmFsc2VcbiAgICBjb25zdCBuZXdPcHRzID0ge1xuICAgICAgLi4ub3B0cyxcbiAgICAgIHBhZ2VTaXplLFxuICAgICAgcHJpbnRTZWxlY3Rpb25Pbmx5LFxuICAgIH1cbiAgICBhd2FpdCB0aGlzLnByZXBhcmVTYXZlVG9QREYobmV3T3B0cylcbiAgICB0cnkge1xuICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IG5ldyBQcm9taXNlPEJ1ZmZlcj4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICAvLyBUT0RPOiBDb21wbGFpbiBvbiBFbGVjdHJvblxuICAgICAgICB0aGlzLl9lbGVtZW50LnByaW50VG9QREYobmV3T3B0cyBhcyBhbnksIChlcnJvciwgZGF0YSkgPT4ge1xuICAgICAgICAgIGlmIChlcnJvcikge1xuICAgICAgICAgICAgcmVqZWN0KGVycm9yKVxuICAgICAgICAgICAgcmV0dXJuXG4gICAgICAgICAgfVxuICAgICAgICAgIHJlc29sdmUoZGF0YSlcbiAgICAgICAgfSlcbiAgICAgIH0pXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgIGZzLndyaXRlRmlsZShmaWxlUGF0aCwgZGF0YSwgKGVycm9yKSA9PiB7XG4gICAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgICByZWplY3QoZXJyb3IpXG4gICAgICAgICAgICByZXR1cm5cbiAgICAgICAgICB9XG4gICAgICAgICAgcmVzb2x2ZSgpXG4gICAgICAgIH0pXG4gICAgICB9KVxuICAgIH0gZmluYWxseSB7XG4gICAgICBoYW5kbGVQcm9taXNlKHRoaXMuZmluaXNoU2F2ZVRvUERGKCkpXG4gICAgfVxuICB9XG5cbiAgcHVibGljIHN5bmMobGluZTogbnVtYmVyLCBmbGFzaDogYm9vbGVhbikge1xuICAgIHRoaXMuX2VsZW1lbnQuc2VuZDwnc3luYyc+KCdzeW5jJywgeyBsaW5lLCBmbGFzaCB9KVxuICB9XG5cbiAgcHVibGljIGFzeW5jIHN5bmNTb3VyY2UoKSB7XG4gICAgcmV0dXJuIHRoaXMucnVuUmVxdWVzdCgnc3luYy1zb3VyY2UnLCB7fSlcbiAgfVxuXG4gIHB1YmxpYyBzY3JvbGxTeW5jKGZpcnN0TGluZTogbnVtYmVyLCBsYXN0TGluZTogbnVtYmVyKSB7XG4gICAgdGhpcy5fZWxlbWVudC5zZW5kPCdzY3JvbGwtc3luYyc+KCdzY3JvbGwtc3luYycsIHsgZmlyc3RMaW5lLCBsYXN0TGluZSB9KVxuICB9XG5cbiAgcHVibGljIHpvb21JbigpIHtcbiAgICB0aGlzLnpvb21MZXZlbCArPSAwLjFcbiAgICB0aGlzLl9lbGVtZW50LnNldFpvb21MZXZlbCh0aGlzLnpvb21MZXZlbClcbiAgfVxuXG4gIHB1YmxpYyB6b29tT3V0KCkge1xuICAgIHRoaXMuem9vbUxldmVsIC09IDAuMVxuICAgIHRoaXMuX2VsZW1lbnQuc2V0Wm9vbUxldmVsKHRoaXMuem9vbUxldmVsKVxuICB9XG5cbiAgcHVibGljIHJlc2V0Wm9vbSgpIHtcbiAgICB0aGlzLnpvb21MZXZlbCA9IDBcbiAgICB0aGlzLl9lbGVtZW50LnNldFpvb21MZXZlbCh0aGlzLnpvb21MZXZlbClcbiAgfVxuXG4gIHB1YmxpYyBwcmludCgpIHtcbiAgICB0aGlzLl9lbGVtZW50LnByaW50KClcbiAgfVxuXG4gIHB1YmxpYyBvcGVuRGV2VG9vbHMoKSB7XG4gICAgdGhpcy5fZWxlbWVudC5vcGVuRGV2VG9vbHMoKVxuICB9XG5cbiAgcHVibGljIGFzeW5jIHJlbG9hZCgpIHtcbiAgICBhd2FpdCB0aGlzLnJ1blJlcXVlc3QoJ3JlbG9hZCcsIHt9KVxuICAgIHRoaXMuX2VsZW1lbnQucmVsb2FkKClcbiAgfVxuXG4gIHB1YmxpYyBlcnJvcihtc2c6IHN0cmluZykge1xuICAgIHRoaXMuX2VsZW1lbnQuc2VuZDwnZXJyb3InPignZXJyb3InLCB7IG1zZyB9KVxuICB9XG5cbiAgcHVibGljIGFzeW5jIGdldFRlWENvbmZpZygpIHtcbiAgICByZXR1cm4gdGhpcy5ydW5SZXF1ZXN0KCdnZXQtdGV4LWNvbmZpZycsIHt9KVxuICB9XG5cbiAgcHVibGljIGFzeW5jIGdldFNlbGVjdGlvbigpIHtcbiAgICByZXR1cm4gdGhpcy5ydW5SZXF1ZXN0KCdnZXQtc2VsZWN0aW9uJywge30pXG4gIH1cblxuICBwcm90ZWN0ZWQgYXN5bmMgcnVuUmVxdWVzdDxUIGV4dGVuZHMga2V5b2YgUmVxdWVzdFJlcGx5TWFwPihcbiAgICByZXF1ZXN0OiBULFxuICAgIGFyZ3M6IHsgW0sgaW4gRXhjbHVkZTxrZXlvZiBDaGFubmVsTWFwW1RdLCAnaWQnPl06IENoYW5uZWxNYXBbVF1bS10gfSxcbiAgKSB7XG4gICAgY29uc3QgaWQgPSB0aGlzLnJlcGx5Q2FsbGJhY2tJZCsrXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPFJlcXVlc3RSZXBseU1hcFtUXT4oKHJlc29sdmUpID0+IHtcbiAgICAgIHRoaXMucmVwbHlDYWxsYmFja3Muc2V0KGlkLCB7XG4gICAgICAgIHJlcXVlc3Q6IHJlcXVlc3QsXG4gICAgICAgIGNhbGxiYWNrOiAocmVzdWx0OiBSZXF1ZXN0UmVwbHlNYXBbVF0pID0+IHtcbiAgICAgICAgICB0aGlzLnJlcGx5Q2FsbGJhY2tzLmRlbGV0ZShpZClcbiAgICAgICAgICByZXNvbHZlKHJlc3VsdClcbiAgICAgICAgfSxcbiAgICAgIH0gYXMgUmVwbHlDYWxsYmFja1N0cnVjdDxUPilcbiAgICAgIGNvbnN0IG5ld2FyZ3MgPSBPYmplY3QuYXNzaWduKHsgaWQgfSwgYXJncylcbiAgICAgIHRoaXMuX2VsZW1lbnQuc2VuZDxUPihyZXF1ZXN0LCBuZXdhcmdzKVxuICAgIH0pXG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHByZXBhcmVTYXZlVG9QREYob3B0czoge1xuICAgIHBhZ2VTaXplOiBQYWdlU2l6ZVxuICAgIGxhbmRzY2FwZTogYm9vbGVhblxuICB9KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgW3dpZHRoLCBoZWlnaHRdID0gZ2V0UGFnZVdpZHRoKG9wdHMucGFnZVNpemUpXG4gICAgcmV0dXJuIHRoaXMucnVuUmVxdWVzdCgnc2V0LXdpZHRoJywge1xuICAgICAgd2lkdGg6IG9wdHMubGFuZHNjYXBlID8gaGVpZ2h0IDogd2lkdGgsXG4gICAgfSlcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgZmluaXNoU2F2ZVRvUERGKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiB0aGlzLnJ1blJlcXVlc3QoJ3NldC13aWR0aCcsIHsgd2lkdGg6IHVuZGVmaW5lZCB9KVxuICB9XG5cbiAgcHJpdmF0ZSB1cGRhdGVTdHlsZXMoKSB7XG4gICAgY29uc3Qgc3R5bGVzOiBzdHJpbmdbXSA9IFtdXG4gICAgZm9yIChjb25zdCBzZSBvZiBhdG9tLnN0eWxlcy5nZXRTdHlsZUVsZW1lbnRzKCkpIHtcbiAgICAgIHN0eWxlcy5wdXNoKHNlLmlubmVySFRNTClcbiAgICB9XG4gICAgdGhpcy5fZWxlbWVudC5zZW5kPCdzdHlsZSc+KCdzdHlsZScsIHsgc3R5bGVzIH0pXG4gIH1cbn1cblxudHlwZSBVbml0ID0gJ21tJyB8ICdjbScgfCAnaW4nXG5cbmZ1bmN0aW9uIHBhcnNlUGFnZVNpemUoc2l6ZTogc3RyaW5nKSB7XG4gIGlmICghc2l6ZSkgcmV0dXJuIHVuZGVmaW5lZFxuICBjb25zdCByeCA9IC9eKFtcXGQuLF0rKShjbXxtbXxpbik/eChbXFxkLixdKykoY218bW18aW4pPyQvaVxuICBjb25zdCByZXMgPSBzaXplLnJlcGxhY2UoL1xccyovZywgJycpLm1hdGNoKHJ4KVxuICBpZiAocmVzKSB7XG4gICAgY29uc3Qgd2lkdGggPSBwYXJzZUZsb2F0KHJlc1sxXSlcbiAgICBjb25zdCB3dW5pdCA9IHJlc1syXSBhcyBVbml0IHwgdW5kZWZpbmVkXG4gICAgY29uc3QgaGVpZ2h0ID0gcGFyc2VGbG9hdChyZXNbM10pXG4gICAgY29uc3QgaHVuaXQgPSByZXNbNF0gYXMgVW5pdCB8IHVuZGVmaW5lZFxuICAgIHJldHVybiB7XG4gICAgICB3aWR0aDogY29udmVydCh3aWR0aCwgd3VuaXQpLFxuICAgICAgaGVpZ2h0OiBjb252ZXJ0KGhlaWdodCwgaHVuaXQpLFxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkXG4gIH1cbn1cblxudHlwZSBQYWdlU2l6ZSA9XG4gIHwgRXhjbHVkZTxcbiAgICAgIENvbmZpZ1ZhbHVlc1snbWFya2Rvd24tcHJldmlldy1wbHVzLnNhdmVDb25maWcuc2F2ZVRvUERGT3B0aW9ucy5wYWdlU2l6ZSddLFxuICAgICAgJ0N1c3RvbSdcbiAgICA+XG4gIHwgeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9XG5cbmZ1bmN0aW9uIGNvbnZlcnQodmFsOiBudW1iZXIsIHVuaXQ/OiBVbml0KSB7XG4gIHJldHVybiB2YWwgKiB1bml0SW5NaWNyb25zKHVuaXQpXG59XG5cbmZ1bmN0aW9uIHVuaXRJbk1pY3JvbnModW5pdDogVW5pdCA9ICdtbScpIHtcbiAgc3dpdGNoICh1bml0KSB7XG4gICAgY2FzZSAnbW0nOlxuICAgICAgcmV0dXJuIDEwMDBcbiAgICBjYXNlICdjbSc6XG4gICAgICByZXR1cm4gMTAwMDBcbiAgICBjYXNlICdpbic6XG4gICAgICByZXR1cm4gMjU0MDBcbiAgfVxufVxuXG5mdW5jdGlvbiBnZXRQYWdlV2lkdGgocGFnZVNpemU6IFBhZ2VTaXplKSB7XG4gIHN3aXRjaCAocGFnZVNpemUpIHtcbiAgICBjYXNlICdBMyc6XG4gICAgICByZXR1cm4gWzI5NywgNDIwXVxuICAgIGNhc2UgJ0E0JzpcbiAgICAgIHJldHVybiBbMjEwLCAyOTddXG4gICAgY2FzZSAnQTUnOlxuICAgICAgcmV0dXJuIFsxNDgsIDIxMF1cbiAgICBjYXNlICdMZWdhbCc6XG4gICAgICByZXR1cm4gWzIxNiwgMzU2XVxuICAgIGNhc2UgJ0xldHRlcic6XG4gICAgICByZXR1cm4gWzIxNiwgMjc5XVxuICAgIGNhc2UgJ1RhYmxvaWQnOlxuICAgICAgcmV0dXJuIFsyNzksIDQzMl1cbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIFtwYWdlU2l6ZS53aWR0aCAvIDEwMDAsIHBhZ2VTaXplLmhlaWdodCAvIDEwMDBdXG4gIH1cbn1cbiJdfQ==