import * as YAML from 'yaml';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import pino from 'pino';

/**
 * YAML Updater - Preserves comments and formatting
 * Uses yaml package's Document API for comment-preserving edits
 */
export class YamlUpdater {
  constructor(
    private readonly hostExecutor: IHostExecutor,
    private readonly logger: pino.Logger,
  ) {}

  /**
   * Update specific paths in a YAML file without destroying comments/formatting
   * @param filePath Path to YAML file
   * @param updates Object with paths to update (e.g., { 'nrf.sbi.server.0.address': '127.0.0.11' })
   */
  async updateYamlFile(filePath: string, updates: Record<string, any>): Promise<void> {
    try {
      // Read current file
      const content = await this.hostExecutor.readFile(filePath);
      
      // Parse as Document (preserves comments)
      const doc = YAML.parseDocument(content);
      
      // Apply each update
      for (const [path, value] of Object.entries(updates)) {
        const pathArray = this.parsePath(path);
        doc.setIn(pathArray, value);
        this.logger.debug({ path, value }, 'Updated YAML path');
      }
      
      // Write back (preserves formatting)
      const updatedContent = doc.toString();
      await this.hostExecutor.writeFile(filePath, updatedContent);
      
      this.logger.info({ filePath, updateCount: Object.keys(updates).length }, 'YAML file updated');
    } catch (err) {
      this.logger.error({ filePath, err: String(err) }, 'Failed to update YAML file');
      throw err;
    }
  }

  /**
   * Parse a dot-notation path into array segments
   * Handles array indices: 'nrf.sbi.server.0.address' => ['nrf', 'sbi', 'server', 0, 'address']
   */
  private parsePath(path: string): Array<string | number> {
    return path.split('.').map(segment => {
      const num = parseInt(segment, 10);
      return isNaN(num) ? segment : num;
    });
  }

  /**
   * Get value at path
   */
  async getYamlValue(filePath: string, path: string): Promise<any> {
    const content = await this.hostExecutor.readFile(filePath);
    const doc = YAML.parseDocument(content);
    const pathArray = this.parsePath(path);
    return doc.getIn(pathArray);
  }
}
