import { Bridge, type BridgeContext } from './bridge/protocol';
import { browserVersion, detectCapabilities, type Capabilities } from './session/capabilities';
import { LIMITS, formatBytes } from './security/limits';
import {
  consumeSanitizeStats,
  resolveResources,
  sanitizeFragment,
  sanitizeHtmlDocument,
  type ResourceHost,
} from './security/sanitize';
import { CSS_LIGHT_DARK } from './session/theme';
import { RenderScheduler, nextFrame } from './scheduler/queue';
import { DocumentWorkerClient } from './workers/client';
import { MathRenderer } from './renderers/math';
import { MermaidRenderer, type MermaidTheme } from './renderers/mermaid';
import { SmilesRenderer, parseSmilesRecords } from './renderers/smiles';
import { mountCsvViewer, type CsvViewerHandle } from './renderers/csv';
import { renderText } from './renderers/text';
import { renderSvgDocument } from './renderers/svg';
import { HighlightService } from './markdown/highlight';
import { buildTocList, fillTocMarkers, insertBlocks, normaliseFootnotes } from './renderers/markdown';
import { ExportController } from './export/export';
import type { HeadingEntry, ParseResult } from './markdown/engine';

/**
 * LiteDoc renderer shell.
 *
 * Responsibilities kept here:
 * * capability probe and the "source mode" fallback when the WebView cannot run
 *   the engines;
 * * one document generation at a time, with cancellation and disposal on switch;
 * * routing a document to the right renderer and reporting what actually happened;
 * * the push protocol from native code (menu, preferences, export, source mode).
 *
 * Document text is fetched from the local session route and never travels over the
 * message bridge.
 */
interface SessionDescriptor {
  sessionId: string | null;
  generation: number;
  kind: string;
  renderMode: 'rich' | 'source' | 'source-only' | string;
  displayName: string;
  mimeType: string;
  charset: string;
  sizeBytes: number;
  confidence: string;
  detection: string;
  warning: string | null;
  sourceUrl: string | null;
  capabilities: {
    rich: boolean;
    remoteImages: boolean;
    allowLanImages: boolean;
    folderGranted: boolean;
    theme: 'system' | 'light' | 'dark';
    fontScale: 'small' | 'normal' | 'large' | 'huge';
    wrap: boolean;
    version: string;
  };
  attachmentRoot?: { label: string; base: string; confirmed: boolean };
}

const FONT_SCALES: Record<string, number> = {
  small: 0.9,
  normal: 1,
  large: 1.18,
  huge: 1.4,
};

class LiteDocShell implements ResourceHost {
  private readonly capabilities: Capabilities = detectCapabilities();
  private bridge: Bridge | null = null;
  private worker: DocumentWorkerClient | null = null;
  private readonly scheduler = new RenderScheduler(1);
  private readonly math = new MathRenderer();
  private readonly mermaid = new MermaidRenderer();
  private readonly smiles = new SmilesRenderer();
  private readonly highlight = new HighlightService();
  private export: ExportController | null = null;
  private csvViewer: CsvViewerHandle | null = null;

  private readonly content = document.getElementById('ld-content') as HTMLElement;
  private readonly status = document.getElementById('ld-status') as HTMLElement;
  private readonly tocPanel = document.getElementById('ld-toc') as HTMLElement;
  private readonly errorBox = document.getElementById('ld-error') as HTMLElement;

  private descriptor: SessionDescriptor | null = null;
  private source = '';
  private headings: HeadingEntry[] = [];
  private generation = 0;
  private activeGeneration = 0;
  private sourceMode = false;
  private disposed = false;
  private statusTimer = 0;

  async start(): Promise<void> {
    this.installInteractionHandlers();
    this.applyTheme('system');

    if (!this.capabilities.bridge || typeof window.litedoc === 'undefined') {
      // Without the secure message API the shell cannot receive a document
      // descriptor; native code loads the plain source route instead.
      this.reportError('bridge-unavailable', '安全消息接口不可用，已切换到源码阅读模式');
      return;
    }

    this.bridge = new Bridge(window.litedoc);
    this.bridge.onPush((method, params) => {
      void this.onPush(method, params);
    });

    try {
      const descriptor = await this.bridge.request<SessionDescriptor>('ready', {
        capabilities: this.capabilities,
        browser: browserVersion(),
      });
      await this.loadDocument(descriptor);
    } catch (error) {
      this.reportError('ready-failed', error instanceof Error ? error.message : 'unknown');
    }
  }

  // ------------------------------------------------------------- document load

  private async loadDocument(descriptor: SessionDescriptor): Promise<void> {
    this.disposeDocument();
    this.descriptor = descriptor;
    this.generation = descriptor.generation;
    this.activeGeneration = descriptor.generation;
    this.sourceMode = descriptor.renderMode !== 'rich';
    this.headings = [];
    this.applyPreferences(descriptor);

    if (!descriptor.sourceUrl) {
      this.reportError('no-source', '没有可读取的文档内容');
      return;
    }

    this.setStatus('正在读取文档…');
    let text: string;
    try {
      text = await this.fetchSource(descriptor.sourceUrl);
    } catch (error) {
      this.reportError('source-failed', error instanceof Error ? error.message : 'unknown');
      return;
    }
    if (!this.isActive(this.generation)) return;
    this.source = text;

    const rich = descriptor.renderMode === 'rich' && this.richUsable(descriptor.kind);
    if (!rich && !this.sourceMode) {
      this.sourceMode = true;
    }

    try {
      if (!rich) {
        await this.renderSource(text, descriptor.kind);
      } else {
        await this.renderRich(text, descriptor.kind);
      }
    } catch (error) {
      this.reportError('render-failed', error instanceof Error ? error.message : 'unknown');
      await this.renderSource(text, descriptor.kind).catch(() => undefined);
      return;
    }

    if (!this.isActive(this.generation)) return;
    this.setStatus(null);
    this.reportStats();
  }

  private richUsable(kind: string): boolean {
    if (!this.capabilities.moduleWorker && (kind === 'markdown' || kind === 'csv' || kind === 'tsv')) {
      return false;
    }
    return this.capabilities.intersectionObserver || kind !== 'markdown';
  }

  private async fetchSource(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`source route returned ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > LIMITS.sourceMaxBytes) {
        throw new Error(`document exceeds ${formatBytes(LIMITS.sourceMaxBytes)}`);
      }
      return new TextDecoder('utf-8').decode(buffer);
    } finally {
      window.clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------- renderers

  private async renderRich(text: string, kind: string): Promise<void> {
    switch (kind) {
      case 'markdown':
        await this.renderMarkdown(text);
        return;
      case 'csv':
      case 'tsv': {
        const handle = await this.renderCsvBlock(this.content, text, kind);
        this.csvViewer = handle;
        return;
      }
      case 'svg': {
        const viewer = renderSvgDocument(text, this.descriptor?.displayName ?? 'drawing');
        this.content.appendChild(viewer.element);
        return;
      }
      case 'mermaid': {
        const block = this.createFencedBlock('mermaid', text);
        this.content.appendChild(block);
        await this.renderMermaidBlock(block, text, this.generation);
        return;
      }
      case 'smiles': {
        const block = this.createFencedBlock('smiles', text);
        this.content.appendChild(block);
        await this.renderSmilesBlock(block, text, this.generation);
        return;
      }
      case 'html': {
        const document_ = sanitizeHtmlDocument(text);
        const container = document.createElement('div');
        container.className = 'ld-html-document';
        container.innerHTML = document_.html;
        this.content.appendChild(container);
        void resolveResources(container, this);
        return;
      }
      default:
        await this.renderSource(text, kind);
    }
  }

  private async renderMarkdown(text: string): Promise<void> {
    const worker = this.ensureWorker();
    this.setStatus('正在解析文档…');
    const parsed: ParseResult = worker
      ? await worker.parse(this.generation, text)
      : await this.parseFallback(text);
    if (!this.isActive(this.generation)) return;

    this.headings = parsed.headings;
    this.content.dataset.ldSourceLength = String(text.length);
    await this.writeDiagnostics(parsed);

    const inserted = await insertBlocks(this.content, parsed.blocks, this.generation, {
      sanitize: (html) => sanitizeFragment(html),
      isActive: (generation) => this.isActive(generation),
      onBatchInserted: (nodes) => {
        this.scheduler.start(this.content, this.generation);
        for (const node of nodes) {
          for (const block of Array.from(node.querySelectorAll<HTMLElement>('[data-ld-kind]'))) {
            this.scheduler.observe(block);
          }
        }
        void nextFrame();
      },
      resolveResources: (nodes, generation) => {
        if (!this.isActive(generation)) return;
        const stats = consumeSanitizeStats();
        if (stats.inlineSvgRemoved > 0) {
          this.showNotice(`已按安全策略移除 ${stats.inlineSvgRemoved} 处内联 SVG`);
        }
        for (const node of nodes) {
          void resolveResources(node, this);
        }
      },
    });
    if (!this.isActive(this.generation)) return;

    normaliseFootnotes(this.content);
    fillTocMarkers(this.content, this.headings);
    this.buildTocPanel();

    // Math is typeset once, for the whole document, in source order.
    if (this.math.hasMath(this.content)) {
      this.setStatus('正在排版公式…');
      try {
        await this.math.ensureLoaded(document.baseURI);
        const result = await this.math.typeset(this.content);
        if (result.skipped) {
          this.showNotice(`公式未排版：${result.skipped}`);
        } else if (result.failed > 0) {
          this.showNotice(`${result.failed} 个公式未能在离线引擎中排版，已保留源码`);
        }
      } catch (error) {
        this.showNotice('离线公式引擎未能启动，公式已按源码显示');
        this.bridge?.notify(
          'reportRenderError',
          { code: 'math-engine', message: error instanceof Error ? error.message : 'unknown' },
          this.context(),
        );
      }
    }

    this.installCodeHighlighting();
    void inserted;
  }

  private async parseFallback(text: string): Promise<ParseResult> {
    const { createMarkdown, parseDocument } = await import('./markdown/engine');
    const markdown = createMarkdown();
    return parseDocument(markdown, text);
  }

  private async renderSource(text: string, kind: string): Promise<void> {
    this.sourceMode = true;
    this.content.textContent = '';
    this.scheduler.stop();
    const language = kind === 'source' || kind === 'latex' ? this.languageFromName() : null;
    const result = renderText(text, { highlightLanguage: language });
    this.content.appendChild(result.element);
    this.setStatus(null);
    if (result.highlighted && language) {
      await this.highlightRoot(this.content);
    }
  }

  private languageFromName(): string | null {
    const name = this.descriptor?.displayName ?? '';
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
    return HighlightService.supports(extension) ? extension : null;
  }

  private createFencedBlock(kind: string, source: string): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'ld-block';
    wrapper.dataset.ldKind = kind;
    wrapper.dataset.ldIndex = '0';
    const header = document.createElement('div');
    header.className = 'ld-block-header';
    const label = document.createElement('span');
    label.className = 'ld-block-label';
    label.textContent = kind.toUpperCase();
    const tools = document.createElement('span');
    tools.className = 'ld-block-tools';
    tools.innerHTML =
      '<button type="button" data-ld-action="copy-source">复制源码</button>' +
      '<button type="button" data-ld-action="fullscreen">全屏</button>';
    header.append(label, tools);
    const body = document.createElement('div');
    body.className = 'ld-block-body';
    const sourcePre = document.createElement('pre');
    sourcePre.className = 'ld-block-source';
    sourcePre.hidden = true;
    sourcePre.textContent = source;
    wrapper.append(header, body, sourcePre);
    return wrapper;
  }

  private async renderMermaidBlock(block: HTMLElement, source: string, generation: number): Promise<void> {
    const body = block.querySelector<HTMLElement>('.ld-block-body');
    if (!body) return;
    if (source.length > LIMITS.mermaidMaxSource) {
      this.failBlock(block, '图表源码超过单块上限');
      return;
    }
    try {
      await this.mermaid.ensureLoaded(document.baseURI);
      if (!this.isActive(generation)) return;
      this.mermaid.initialize(this.mermaidTheme());
      const result = await this.mermaid.renderDiagram(source, this.mermaidTheme(), `s${source.length}-${hash(source)}`);
      if (!this.isActive(generation)) return;
      body.innerHTML = result.svg;
      const svg = body.querySelector('svg');
      if (svg) {
        svg.removeAttribute('height');
        svg.style.maxWidth = '100%';
      }
      block.classList.remove('ld-block-error');
      this.attachGraphicTools(block, body);
      result.bindFunctions?.(body);
    } catch (error) {
      if (!this.isActive(generation)) return;
      this.failBlock(block, error instanceof Error ? error.message : '图表渲染失败');
    }
  }

  private async renderSmilesBlock(block: HTMLElement, source: string, generation: number): Promise<void> {
    const body = block.querySelector<HTMLElement>('.ld-block-body');
    if (!body) return;
    const parsed = parseSmilesRecords(source, LIMITS.smilesMaxRecords);
    body.textContent = '';
    if (parsed.records.length === 0 && parsed.unsupported.length === 0) {
      this.failBlock(block, '没有可绘制的 SMILES 记录');
      return;
    }
    try {
      await this.smiles.ensureLoaded();
    } catch (error) {
      this.failBlock(block, error instanceof Error ? error.message : '结构绘制库未能加载');
      return;
    }

    const theme = this.currentTheme() === 'dark' ? 'dark' : 'light';
    for (const record of parsed.records) {
      if (!this.isActive(generation)) return;
      const item = document.createElement('figure');
      item.className = 'ld-smiles-record';
      const canvas = document.createElement('div');
      canvas.className = 'ld-canvas';
      canvas.dataset.ldBg = theme === 'dark' ? 'dark' : 'white';
      const caption = document.createElement('figcaption');
      caption.textContent = record.name.length > 0 ? record.name : `第 ${record.line} 行`;
      item.append(canvas, caption);
      body.appendChild(item);
      const failure = this.smiles.draw(canvas, record, theme);
      if (failure) {
        canvas.textContent = '';
        const message = document.createElement('p');
        message.className = 'ld-notice';
        message.textContent = `第 ${record.line} 行无法绘制：${failure}`;
        canvas.appendChild(message);
        item.appendChild(this.sourceDisclosure([record.smiles]));
      }
    }

    if (parsed.unsupported.length > 0) {
      const notice = document.createElement('p');
      notice.className = 'ld-notice';
      notice.textContent = `${parsed.unsupported.length} 条记录不是二维 SMILES（反应式/InChI 不在本版范围内），已按源码保留`;
      body.appendChild(notice);
      body.appendChild(this.sourceDisclosure(parsed.unsupported.map((entry) => entry.text)));
    }
    if (parsed.truncated) {
      const notice = document.createElement('p');
      notice.className = 'ld-notice';
      notice.textContent = `记录超过 ${LIMITS.smilesMaxRecords} 条，仅绘制前 ${LIMITS.smilesMaxRecords} 条`;
      body.appendChild(notice);
    }
    this.attachGraphicTools(block, body);
  }

  private sourceDisclosure(lines: string[]): HTMLElement {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '查看源码';
    const pre = document.createElement('pre');
    pre.className = 'ld-block-source';
    pre.textContent = lines.join('\n');
    details.append(summary, pre);
    return details;
  }

  private failBlock(block: HTMLElement, message: string): void {
    block.classList.add('ld-block-error');
    const body = block.querySelector<HTMLElement>('.ld-block-body');
    if (body) {
      body.textContent = '';
      const paragraph = document.createElement('p');
      paragraph.textContent = message;
      body.appendChild(paragraph);
      body.hidden = false;
    }
    const source = block.querySelector<HTMLElement>('.ld-block-source');
    if (source) source.hidden = false;
    this.bridge?.notify(
      'reportRenderError',
      { code: 'block', message },
      this.context(),
    );
  }

  private attachGraphicTools(block: HTMLElement, body: HTMLElement): void {
    if (body.querySelector('svg')) {
      body.classList.add('ld-graphic');
      const tools = block.querySelector('.ld-block-tools');
      if (tools && !tools.querySelector('[data-ld-action="graphic-export"]')) {
        const svgButton = document.createElement('button');
        svgButton.type = 'button';
        svgButton.dataset.ldAction = 'graphic-export';
        svgButton.dataset.ldFormat = 'svg';
        svgButton.textContent = '导出 SVG';
        const pngButton = document.createElement('button');
        pngButton.type = 'button';
        pngButton.dataset.ldAction = 'graphic-export';
        pngButton.dataset.ldFormat = 'png';
        pngButton.textContent = '导出 PNG';
        tools.append(svgButton, pngButton);
      }
    }
  }

  private async renderCsvBlock(
    parent: HTMLElement,
    text: string,
    kind: 'csv' | 'tsv',
  ): Promise<CsvViewerHandle | null> {
    const worker = this.ensureWorker();
    if (!worker) {
      await this.renderSource(text, 'text');
      return null;
    }
    const block = this.createFencedBlock(kind, text);
    parent.appendChild(block);
    const body = block.querySelector<HTMLElement>('.ld-block-body');
    if (!body) return null;
    return mountCsvViewer(body, {
      client: worker,
      generation: this.generation,
      source: text,
      kind,
      getTheme: () => this.currentTheme(),
    });
  }

  private ensureWorker(): DocumentWorkerClient | null {
    if (this.worker) return this.worker;
    if (!this.capabilities.moduleWorker) return null;
    try {
      const url = new URL('assets/document.worker.js', document.baseURI).href;
      this.worker = DocumentWorkerClient.create(url);
      return this.worker;
    } catch (error) {
      this.showNotice('解析 Worker 不可用，已改用主线程解析');
      this.bridge?.notify(
        'reportRenderError',
        { code: 'worker', message: error instanceof Error ? error.message : 'unknown' },
        this.context(),
      );
      return null;
    }
  }

  private installCodeHighlighting(): void {
    for (const pre of Array.from(this.content.querySelectorAll<HTMLElement>('pre[data-ld-code]'))) {
      if (!pre.dataset.ldCode) continue;
      const language = pre.dataset.ldCode;
      const code = pre.querySelector('code');
      if (!code) continue;
      void this.highlight
        .highlight(code.textContent ?? '', language)
        .then((html) => {
          if (html === null || !this.isActive(this.generation)) return;
          const sanitized = sanitizeFragment(html);
          code.innerHTML = sanitized;
          pre.dataset.ldHighlighted = '1';
        })
        .catch(() => undefined);
    }
  }

  private async highlightRoot(root: HTMLElement): Promise<void> {
    const holder = root.querySelector<HTMLElement>('pre.ld-source');
    const language = holder?.dataset.ldHighlight;
    if (!holder || !language) return;
    const target = holder.querySelector<HTMLElement>('.ld-source-line') ?? holder;
    void target;
    const plain = holder.dataset.ldPlain ?? '';
    const html = await this.highlight.highlight(plain, language);
    if (html === null || !this.isActive(this.generation)) return;
    holder.innerHTML = sanitizeFragment(html);
    holder.classList.add('ld-source-highlighted');
  }

  // -------------------------------------------------------------- interaction

  private installInteractionHandlers(): void {
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target as HTMLElement | null;
        if (!target) return;

        const action = target.closest<HTMLElement>('[data-ld-action]');
        if (action) {
          event.preventDefault();
          this.handleAction(action);
          return;
        }

        const anchor = target.closest<HTMLAnchorElement>('a');
        if (anchor) {
          if (anchor.getAttribute('href')?.startsWith('#')) {
            event.preventDefault();
            this.scrollToAnchor(anchor.getAttribute('href')!.slice(1));
            return;
          }
          const href = anchor.dataset.ldHref ?? anchor.getAttribute('data-ld-href') ?? '';
          if (href.length > 0) {
            event.preventDefault();
            this.copyText(href);
            return;
          }
          event.preventDefault();
        }
      },
      true,
    );

    document.addEventListener('error', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target || target.tagName !== 'IMG') return;
      const image = target as HTMLImageElement;
      image.classList.add('ld-image-failed');
      if (image.dataset.ldFailed === '1') return;
      image.dataset.ldFailed = '1';
      const placeholder = document.createElement('span');
      placeholder.className = 'ld-image-placeholder';
      placeholder.textContent = '图片不可用';
      image.replaceWith(placeholder);
    }, true);
  }

  private handleAction(action: HTMLElement): void {
    const kind = action.dataset.ldAction;
    switch (kind) {
      case 'copy-source': {
        const block = action.closest('.ld-block');
        const source = block?.querySelector<HTMLElement>('.ld-block-source');
        if (source) this.copyText(source.textContent ?? '');
        return;
      }
      case 'fullscreen': {
        const block = action.closest<HTMLElement>('.ld-block');
        if (block) block.classList.toggle('ld-fullscreen');
        return;
      }
      case 'svg-bg': {
        const canvas = action.closest('.ld-block')?.querySelector<HTMLElement>('.ld-canvas');
        if (canvas) canvas.dataset.ldBg = action.dataset.ldBg ?? 'white';
        return;
      }
      case 'svg-fit': {
        const canvas = action.closest('.ld-block')?.querySelector<HTMLElement>('.ld-canvas');
        const image = canvas?.querySelector('img');
        if (image) {
          image.style.maxWidth = '100%';
          image.style.width = '';
        }
        return;
      }
      case 'svg-actual': {
        const canvas = action.closest('.ld-block')?.querySelector<HTMLElement>('.ld-canvas');
        const image = canvas?.querySelector('img');
        if (image) {
          image.style.maxWidth = 'none';
          image.style.width = `${image.naturalWidth}px`;
        }
        return;
      }
      case 'svg-export':
      case 'graphic-export': {
        const format = action.dataset.ldFormat === 'png' ? 'png' : 'svg';
        void this.requestGraphicExport(format);
        return;
      }
      default:
        return;
    }
  }

  private scrollToAnchor(id: string): void {
    const target = document.getElementById(id);
    if (target) {
      target.scrollIntoView({ block: 'start' });
    }
  }

  private copyText(text: string): void {
    this.bridge?.notify('copyText', { text }, this.context());
  }

  // ------------------------------------------------------------- native pushes

  private async onPush(method: string, params: Record<string, unknown>): Promise<void> {
    switch (method) {
      case 'showToc':
        this.toggleTocPanel();
        return;
      case 'requestSourceMode':
        if (!this.sourceMode) {
          this.sourceMode = true;
          await this.renderSource(this.source, this.descriptor?.kind ?? 'text');
          this.showNotice('源码模式');
        } else {
          this.showNotice('当前已是源码模式');
        }
        return;
      case 'copyAll':
        this.copyText(this.content.innerText);
        return;
      case 'preferenceChanged': {
        const key = String(params.key ?? '');
        const value = String(params.value ?? '');
        this.applyPreference(key, value);
        return;
      }
      case 'folderGrantChanged':
        this.showNotice('附件目录已更新，正在重新解析本地附件…');
        if (this.descriptor) await this.loadDocument(this.descriptor);
        return;
      case 'exportPrepare': {
        const kind = (params.kind === 'svg' || params.kind === 'png' ? params.kind : 'pdf') as 'pdf' | 'svg' | 'png';
        await this.prepareExport(kind);
        return;
      }
      case 'exportTargetReady': {
        const kind = params.kind === 'png' ? 'png' : 'svg';
        await this.export?.streamGraphic(kind);
        return;
      }
      case 'exportFailed':
        this.showNotice(`导出未完成：${String(params.reason ?? 'unknown')}`);
        this.export?.reset();
        return;
      case 'revealNotice':
        this.showNotice(String(params.message ?? ''));
        return;
      case 'closeDocument':
        this.disposeDocument();
        this.content.textContent = '';
        return;
      case 'requestGraphicExport': {
        const format = params.format === 'png' ? 'png' : 'svg';
        await this.requestGraphicExport(format);
        return;
      }
      default:
        return;
    }
  }

  private applyPreference(key: string, value: string): void {
    if (!this.descriptor) return;
    const capabilities = this.descriptor.capabilities;
    switch (key) {
      case 'theme':
        capabilities.theme = value as 'system' | 'light' | 'dark';
        this.applyTheme(capabilities.theme);
        this.mermaid.invalidate();
        void this.rerenderDiagrams();
        return;
      case 'fontScale':
        capabilities.fontScale = value as 'small' | 'normal' | 'large' | 'huge';
        this.applyPreferences(this.descriptor);
        return;
      case 'wrap':
        capabilities.wrap = value === 'true';
        document.documentElement.dataset.wrap = capabilities.wrap ? 'on' : 'off';
        return;
      case 'remoteImages':
        capabilities.remoteImages = value === 'true';
        return;
      case 'allowLanImages':
        capabilities.allowLanImages = value === 'true';
        return;
      default:
        return;
    }
  }

  private applyPreferences(descriptor: SessionDescriptor): void {
    this.applyTheme(descriptor.capabilities.theme);
    const scale = FONT_SCALES[descriptor.capabilities.fontScale] ?? 1;
    document.documentElement.style.setProperty('--ld-base-size', `${16 * scale}px`);
    document.documentElement.dataset.wrap = descriptor.capabilities.wrap ? 'on' : 'off';
  }

  private applyTheme(mode: 'system' | 'light' | 'dark'): void {
    const resolved = mode === 'system' ? CSS_LIGHT_DARK() : mode;
    document.documentElement.dataset.theme = resolved;
  }

  private currentTheme(): 'light' | 'dark' {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }

  private mermaidTheme(): MermaidTheme {
    return {
      theme: this.currentTheme() === 'dark' ? 'dark' : 'default',
      fontFamily: 'system-ui, sans-serif',
      fontSize: 14,
    };
  }

  private async rerenderDiagrams(): Promise<void> {
    const blocks = Array.from(this.content.querySelectorAll<HTMLElement>('[data-ld-kind="mermaid"]'));
    for (const block of blocks) {
      const source = block.querySelector<HTMLElement>('.ld-block-source')?.textContent ?? '';
      if (source.length > 0) {
        await this.renderMermaidBlock(block, source, this.generation);
      }
    }
  }

  private toggleTocPanel(): void {
    if (!this.tocPanel.hidden) {
      this.tocPanel.hidden = true;
      return;
    }
    this.buildTocPanel();
    this.tocPanel.hidden = false;
  }

  private buildTocPanel(): void {
    this.tocPanel.textContent = '';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ld-toc-close';
    close.textContent = '关闭目录';
    close.addEventListener('click', () => {
      this.tocPanel.hidden = true;
    });
    this.tocPanel.appendChild(close);
    if (this.headings.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = '文档没有标题';
      this.tocPanel.appendChild(empty);
      return;
    }
    this.tocPanel.appendChild(buildTocList(this.headings, false));
  }

  // ---------------------------------------------------------------- export

  private async prepareExport(kind: 'pdf' | 'svg' | 'png'): Promise<void> {
    this.export = this.export ?? this.createExportController();
    const result = await this.export.prepare(kind);
    if (result.state === 'failed') {
      this.showNotice('导出准备失败');
    }
  }

  private createExportController(): ExportController {
    return new ExportController({
      bridge: this.bridge as Bridge,
      context: () => this.context(),
      root: () => this.content,
      scheduler: this.scheduler,
      notify: (message) => this.showNotice(message),
      reportError: (code, message) => this.reportError(code, message),
      baseUrl: document.baseURI,
      graphicSource: () => this.graphicSource(),
    });
  }

  private async requestGraphicExport(format: 'svg' | 'png'): Promise<void> {
    if (!this.bridge) return;
    this.export = this.export ?? this.createExportController();
    try {
      await this.bridge.request('requestExport', { kind: format }, this.context());
    } catch (error) {
      this.reportError('export-request-failed', error instanceof Error ? error.message : 'unknown');
    }
  }

  /** Picks the graphic the user is looking at, or the only one in the document. */
  private graphicSource(): { svg: string; width: number; height: number; label: string } | null {
    const candidates = Array.from(this.content.querySelectorAll<SVGSVGElement>('svg'));
    if (candidates.length === 0) return null;
    const viewportCenter = window.innerHeight / 2;
    let best: SVGSVGElement | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const svg of candidates) {
      const rect = svg.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const distance = Math.abs(center - viewportCenter);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = svg;
      }
    }
    const target = best ?? candidates[0]!;
    const rect = target.getBoundingClientRect();
    const clone = target.cloneNode(true) as SVGSVGElement;
    clone.removeAttribute('style');
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!clone.getAttribute('width')) clone.setAttribute('width', String(Math.max(1, Math.round(rect.width || 320))));
    if (!clone.getAttribute('height')) clone.setAttribute('height', String(Math.max(1, Math.round(rect.height || 240))));
    return {
      svg: new XMLSerializer().serializeToString(clone),
      width: Math.max(1, Math.round(rect.width || 320)),
      height: Math.max(1, Math.round(rect.height || 240)),
      label: (this.descriptor?.displayName ?? 'litedoc').replace(/\.[^.]+$/, ''),
    };
  }

  // ------------------------------------------------------------------ helpers

  private async writeDiagnostics(parsed: ParseResult): Promise<void> {
    const stats = consumeSanitizeStats();
    const summary = {
      blocks: parsed.blocks.length,
      math: parsed.features.math,
      mermaid: parsed.features.mermaid,
      smiles: parsed.features.smiles,
      csv: parsed.features.csv + parsed.features.tsv,
      footnotes: parsed.features.footnotes,
      callouts: parsed.features.callouts,
      frontMatter: parsed.features.frontMatter,
      inlineSvgRemoved: stats.inlineSvgRemoved,
    };
    this.content.dataset.ldStats = JSON.stringify(summary);
    if (parsed.features.unknownLanguages.length > 0) {
      this.showNotice(`未知语言未高亮：${parsed.features.unknownLanguages.slice(0, 5).join(', ')}`);
    }
  }

  private reportStats(): void {
    const stats = {
      session: this.descriptor?.sessionId ?? null,
      generation: this.generation,
      sourceMode: this.sourceMode,
      kind: this.descriptor?.kind ?? 'unknown',
      headings: this.headings.length,
      blocks: this.content.childElementCount,
      capabilities: this.capabilities.missing,
      engine: {
        math: this.math.isLoaded() ? this.math.engineVersion() : null,
        mermaid: this.mermaid.isLoaded() ? this.mermaid.engineVersion() : null,
        smiles: this.smiles.isLoaded(),
        worker: this.worker !== null,
      },
    };
    this.bridge?.notify('documentRendered', stats, this.context());
    for (const missing of this.capabilities.missing) {
      this.bridge?.notify(
        'reportRenderError',
        { code: `capability:${missing}`, message: '能力探测缺失，已降级处理' },
        this.context(),
      );
    }
  }

  private context(): BridgeContext {
    return { sessionId: this.descriptor?.sessionId ?? null, generation: this.generation };
  }

  private isActive(generation: number): boolean {
    return !this.disposed && generation === this.activeGeneration;
  }

  private setStatus(message: string | null): void {
    window.clearTimeout(this.statusTimer);
    if (message === null) {
      this.status.hidden = true;
      this.status.textContent = '';
      return;
    }
    this.status.hidden = false;
    this.status.textContent = message;
  }

  private showNotice(message: string): void {
    if (message.length === 0) return;
    this.setStatus(message);
    this.statusTimer = window.setTimeout(() => this.setStatus(null), 4000);
  }

  private reportError(code: string, message: string): void {
    this.errorBox.hidden = false;
    this.errorBox.textContent = `${message}（${code}）`;
    this.bridge?.notify('reportRenderError', { code, message }, this.context());
  }

  private disposeDocument(): void {
    this.activeGeneration = -1;
    this.scheduler.stop();
    this.csvViewer?.dispose();
    this.csvViewer = null;
    this.worker?.cancelGeneration(this.generation);
    this.content.textContent = '';
    this.tocPanel.hidden = true;
    this.errorBox.hidden = true;
    for (const image of Array.from(document.querySelectorAll<HTMLImageElement>('img[data-ld-object-url]'))) {
      const url = image.dataset.ldObjectUrl;
      if (url) URL.revokeObjectURL(url);
    }
  }

  // ------------------------------------------------------- ResourceHost

  async registerRemoteImages(
    urls: string[],
  ): Promise<{ registered: Array<{ url: string; localUrl: string }>; rejected: Array<{ url: string; reason: string }> }> {
    if (!this.bridge) return { registered: [], rejected: urls.map((url) => ({ url, reason: 'no-bridge' })) };
    const response = await this.bridge.request<{
      registered: Array<{ url: string; id: string; localUrl: string }>;
      rejected: Array<{ url: string; reason: string }>;
    }>('registerImages', { urls }, this.context());
    return {
      registered: (response.registered ?? []).map((entry) => ({ url: entry.url, localUrl: entry.localUrl })),
      rejected: response.rejected ?? [],
    };
  }

  async registerLocalResources(
    refs: string[],
  ): Promise<{ registered: Array<{ ref: string; localUrl: string }>; missing: string[] }> {
    if (!this.bridge) return { registered: [], missing: refs };
    const response = await this.bridge.request<{
      registered: Array<{ ref: string; id: string; localUrl: string }>;
      missing: string[];
    }>('registerAttachments', { refs }, this.context());
    return {
      registered: (response.registered ?? []).map((entry) => ({ ref: entry.ref, localUrl: entry.localUrl })),
      missing: response.missing ?? [],
    };
  }

  reportResourceNotice(message: string): void {
    this.showNotice(message);
  }

  dispose(): void {
    this.disposed = true;
    this.bridge?.dispose();
    this.bridge = null;
    this.worker?.terminate();
    this.worker = null;
    this.scheduler.stop();
  }
}

function hash(value: string): number {
  let result = 0;
  for (let i = 0; i < value.length; i += 1) {
    result = (result * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(result);
}

const shell = new LiteDocShell();
void shell.start();

window.addEventListener('error', (event) => {
  const message = event.message || 'unhandled error';
  try {
    window.litedoc?.postMessage(
      JSON.stringify({ v: 1, method: 'reportRenderError', params: { code: 'unhandled', message } }),
    );
  } catch {
    // Nothing else can be reported without the bridge.
  }
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as { message?: string } | undefined;
  try {
    window.litedoc?.postMessage(
      JSON.stringify({
        v: 1,
        method: 'reportRenderError',
        params: { code: 'unhandled-rejection', message: reason?.message ?? 'rejection' },
      }),
    );
  } catch {
    // Ignore.
  }
});

export { LiteDocShell };
