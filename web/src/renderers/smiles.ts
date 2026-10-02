/**
 * SMILES: on-demand 2D structure drawing only.
 *
 * There is no chemistry computation, no balancing, no editor, no 3D view and no
 * property calculation. Each record is drawn independently, so one invalid record
 * never stops the following ones, and a reaction SMARTS/InChI record is reported as
 * unsupported instead of being drawn as if it were a molecule.
 */
export interface SmilesRecord {
  smiles: string;
  name: string;
  line: number;
}

export interface SmilesParseResult {
  records: SmilesRecord[];
  unsupported: Array<{ line: number; reason: string; text: string }>;
  truncated: boolean;
  totalLines: number;
}

export function parseSmilesRecords(source: string, maxRecords: number): SmilesParseResult {
  const records: SmilesRecord[] = [];
  const unsupported: Array<{ line: number; reason: string; text: string }> = [];
  const lines = source.split(/\r\n|\r|\n/);
  let truncated = false;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    const parts = trimmed.split(/\s+/);
    const token = parts[0] ?? '';
    const name = parts.slice(1).join(' ').trim();

    if (token.startsWith('InChI=') || token.startsWith('InChIKey=')) {
      unsupported.push({ line: i + 1, reason: 'InChI', text: trimmed });
      continue;
    }
    if (token.includes('>')) {
      unsupported.push({ line: i + 1, reason: 'reaction', text: trimmed });
      continue;
    }
    if (records.length >= maxRecords) {
      truncated = true;
      continue;
    }
    records.push({ smiles: token, name, line: i + 1 });
  }

  return { records, unsupported, truncated, totalLines: lines.length };
}

interface SvgDrawerLike {
  draw(
    data: string,
    target: Element | string | null,
    themeName?: string,
  ): SVGSVGElement | Element | null;
}

interface SmilesDrawerNamespace {
  SvgDrawer: new (options: Record<string, unknown>) => SvgDrawerLike;
}

export class SmilesRenderer {
  private namespace: SmilesDrawerNamespace | null = null;
  private loading: Promise<SmilesDrawerNamespace> | null = null;

  isLoaded(): boolean {
    return this.namespace !== null;
  }

  async ensureLoaded(): Promise<SmilesDrawerNamespace> {
    if (this.namespace) return this.namespace;
    if (this.loading) return this.loading;
    this.loading = import('smiles-drawer')
      .then((module) => {
        const namespace = (module as { default?: SmilesDrawerNamespace }).default ?? (module as unknown as SmilesDrawerNamespace);
        if (!namespace || typeof namespace.SvgDrawer !== 'function') {
          throw new Error('smiles-drawer-load-failed');
        }
        this.namespace = namespace;
        return namespace;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /**
   * Draws one record into `target`. The drawing library reports an error through a
   * thrown exception or by leaving the target empty, both of which are turned into
   * a local, per-record message.
   */
  draw(target: Element, record: SmilesRecord, theme: 'light' | 'dark'): string | null {
    const namespace = this.namespace;
    if (!namespace) return 'renderer-not-loaded';
    try {
      const drawer = new namespace.SvgDrawer({
        width: 420,
        height: 320,
        bondThickness: 1.1,
        padding: 12,
        compactDrawing: false,
        terminalCarbons: true,
        explicitHydrogens: false,
        isomeric: true,
        debug: false,
        atomVisualization: 'default',
        overdrawHorizontalBond: false,
      });
      const result = drawer.draw(record.smiles, target, theme);
      if (!result) return 'no-output';
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'draw-failed';
    }
  }
}
