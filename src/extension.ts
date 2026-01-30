import * as vscode from "vscode";
import * as http from "http";

let updateInterval: NodeJS.Timeout | undefined;

// 股票数据接口
interface StockData {
  code: string;
  name: string;
  current: string;
  change: string;
  changePercent: string;
  updateTime: string;
}

// 股票数据项
class StockItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly description?: string,
    public readonly tooltip?: string,
    public readonly iconPath?: vscode.ThemeIcon,
    public readonly stockCode?: string,
    public readonly isRoot: boolean = false
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.tooltip = tooltip;
    this.iconPath = iconPath;
  }
}

// 股票数据提供者
class StockDataProvider implements vscode.TreeDataProvider<StockItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    StockItem | undefined | null | void
  > = new vscode.EventEmitter<StockItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    StockItem | undefined | null | void
  > = this._onDidChangeTreeData.event;

  private stocksData: Map<string, StockData> = new Map();
  private isLoading: boolean = true;
  private stockCodes: string[] = [];

  constructor() {
    // 读取配置并获取数据
    this.loadStockCodes();
    this.fetchAllStockData();
  }

  // 加载股票代码配置
  private loadStockCodes(): void {
    // 默认显示上证指数
    this.stockCodes = ["1.000001"];

    // 读取用户配置的股票代码
    const config = vscode.workspace.getConfiguration("stockInvestment");
    const customCodes = config.get<string>("stockCodes", "");

    if (customCodes && customCodes.trim()) {
      const codes = customCodes
        .split(",")
        .map((code) => code.trim())
        .filter((code) => code.length > 0);

      // 将自定义股票代码添加到列表
      this.stockCodes.push(...codes);
    }

    console.log("加载的股票代码:", this.stockCodes);
  }

  // 刷新视图
  refresh(): void {
    this.loadStockCodes();
    this.fetchAllStockData();
  }

  // 获取树节点
  getTreeItem(element: StockItem): vscode.TreeItem {
    return element;
  }

  // 获取子节点
  getChildren(element?: StockItem): Thenable<StockItem[]> {
    if (!element) {
      // 根节点 - 显示所有股票
      return Promise.resolve(this.getRootItems());
    } else if (element.isRoot && element.stockCode) {
      // 展开某个股票 - 显示详细数据
      return Promise.resolve(this.getDetailItems(element.stockCode));
    }
    return Promise.resolve([]);
  }

  // 获取根节点（所有股票列表）
  private getRootItems(): StockItem[] {
    if (this.isLoading) {
      return [
        new StockItem(
          "上证指数",
          vscode.TreeItemCollapsibleState.Collapsed,
          "加载中...",
          "正在获取股票数据",
          new vscode.ThemeIcon("loading~spin"),
          "1.000001",
          true
        ),
      ];
    }

    const items: StockItem[] = [];

    // 按照配置顺序显示股票
    for (const code of this.stockCodes) {
      const stockData = this.stocksData.get(code);

      if (!stockData) {
        items.push(
          new StockItem(
            code,
            vscode.TreeItemCollapsibleState.Collapsed,
            "加载失败",
            "点击刷新按钮重试",
            new vscode.ThemeIcon("error"),
            code,
            true
          )
        );
        continue;
      }

      const { name, current, change, changePercent } = stockData;
      const changeNum = parseFloat(change);
      const isUp = changeNum >= 0;
      const arrow = isUp ? "↑" : "↓";

      items.push(
        new StockItem(
          name,
          vscode.TreeItemCollapsibleState.Collapsed,
          `${current} ${arrow}${changePercent}%`,
          `当前: ${current}\n涨跌: ${arrow} ${change} (${changePercent}%)\n点击展开查看详情`,
          new vscode.ThemeIcon(
            "graph-line",
            new vscode.ThemeColor(isUp ? "charts.green" : "charts.red")
          ),
          code,
          true
        )
      );
    }

    return items;
  }

  // 获取详细数据项
  private getDetailItems(stockCode: string): StockItem[] {
    const stockData = this.stocksData.get(stockCode);

    if (!stockData) {
      return [];
    }

    const { name, current, change, changePercent, updateTime } = stockData;
    const changeNum = parseFloat(change);
    const isUp = changeNum >= 0;
    const arrow = isUp ? "↑" : "↓";

    return [
      new StockItem(
        "当前价格",
        vscode.TreeItemCollapsibleState.None,
        current,
        `${name} 当前价格: ${current}`,
        new vscode.ThemeIcon(
          "symbol-number",
          new vscode.ThemeColor("charts.blue")
        )
      ),
      new StockItem(
        "涨跌点数",
        vscode.TreeItemCollapsibleState.None,
        `${arrow} ${change}`,
        `涨跌点数: ${change}`,
        new vscode.ThemeIcon(
          isUp ? "arrow-up" : "arrow-down",
          new vscode.ThemeColor(isUp ? "charts.green" : "charts.red")
        )
      ),
      new StockItem(
        "涨跌幅",
        vscode.TreeItemCollapsibleState.None,
        `${arrow} ${changePercent}%`,
        `涨跌幅: ${changePercent}%`,
        new vscode.ThemeIcon(
          isUp ? "trending-up" : "trending-down",
          new vscode.ThemeColor(isUp ? "charts.green" : "charts.red")
        )
      ),
      new StockItem(
        "更新时间",
        vscode.TreeItemCollapsibleState.None,
        updateTime,
        `最后更新: ${updateTime}`,
        new vscode.ThemeIcon("clock")
      ),
    ];
  }

  // 获取所有股票数据（批量方式）
  private fetchAllStockData(): void {
    if (this.stockCodes.length === 0) {
      this.isLoading = false;
      this._onDidChangeTreeData.fire();
      return;
    }

    const updateTime = new Date().toLocaleTimeString("zh-CN");

    // 清空旧数据
    this.stocksData.clear();

    // 批量获取股票数据
    this.fetchBatchStocks(this.stockCodes, updateTime, () => {
      this.isLoading = false;
      this._onDidChangeTreeData.fire();
    });
  }

  // 批量获取股票数据
  private fetchBatchStocks(
    stockCodes: string[],
    updateTime: string,
    callback: () => void
  ): void {
    // 使用批量查询API，一次性获取所有股票数据
    const secids = stockCodes.join(",");
    const url = `http://push2.eastmoney.com/api/qt/ulist.np/get?secids=${secids}&fields=f12,f13,f14,f2,f4,f3`;

    console.log(`批量获取 ${stockCodes.length} 只股票数据`);

    http
      .get(url, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            const jsonData = JSON.parse(data);

            if (jsonData && jsonData.data && jsonData.data.diff) {
              const stocks = jsonData.data.diff;

              for (const stockData of stocks) {
                if (!stockData) {
                  continue;
                }

                const marketCode = stockData.f13;
                const code = stockData.f12;
                const stockCode = `${marketCode}.${code}`;
                const name = stockData.f14 || stockCode;

                // 批量查询API返回的数据需要除以100
                const current = (stockData.f2 / 100).toFixed(2);
                const changePercent = (stockData.f3 / 100).toFixed(2);
                const change = (stockData.f4 / 100).toFixed(2);

                console.log(
                  `解析股票 ${stockCode}: 名称=${name}, 价格=${current}, 涨跌=${change}, 涨跌幅=${changePercent}%`
                );

                this.stocksData.set(stockCode, {
                  code: stockCode,
                  name,
                  current,
                  change,
                  changePercent,
                  updateTime,
                });
              }

              console.log(`成功批量获取 ${stocks.length} 只股票数据`);
            } else {
              console.log("批量查询返回数据无效");
            }
          } catch (error) {
            console.error("批量解析股票数据错误:", error);
          }

          callback();
        });
      })
      .on("error", (error) => {
        console.error("批量获取股票数据失败:", error);
        callback();
      });
  }

  // 启动自动更新
  startAutoUpdate(interval: number = 3000): void {
    // 清除已有的定时器
    if (updateInterval) {
      clearInterval(updateInterval);
    }

    // 设置新的定时器
    updateInterval = setInterval(() => {
      this.fetchAllStockData();
    }, interval);
  }

  // 停止自动更新
  stopAutoUpdate(): void {
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = undefined;
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  // 创建股票数据提供者
  const stockDataProvider = new StockDataProvider();

  // 注册 TreeView
  const treeView = vscode.window.createTreeView("stockView", {
    treeDataProvider: stockDataProvider,
    showCollapseAll: false,
  });

  // 启动自动更新（每3秒更新一次）
  stockDataProvider.startAutoUpdate(3000);

  // 监听配置变化
  const configChangeListener = vscode.workspace.onDidChangeConfiguration(
    (e) => {
      if (e.affectsConfiguration("stockInvestment.stockCodes")) {
        console.log("股票代码配置已更改，重新加载数据");
        stockDataProvider.refresh();
      }
    }
  );

  // 注册刷新命令
  const refreshCommand = vscode.commands.registerCommand(
    "stockView.refresh",
    () => {
      stockDataProvider.refresh();
    }
  );

  // 注册打开网站命令
  const openWebsiteCommand = vscode.commands.registerCommand(
    "stockView.openWebsite",
    () => {
      vscode.env.openExternal(vscode.Uri.parse("https://www.eastmoney.com/"));
    }
  );

  // 保留原有的命令（兼容性）
  const openPanelCommand = vscode.commands.registerCommand(
    "extension.showStockPanel",
    async () => {
      // 显示资源管理器侧边栏
      await vscode.commands.executeCommand("workbench.view.explorer");
    }
  );

  // 添加到订阅列表
  context.subscriptions.push(
    treeView,
    configChangeListener,
    refreshCommand,
    openWebsiteCommand,
    openPanelCommand
  );
}

export function deactivate() {
  // 清理资源
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = undefined;
  }
}
