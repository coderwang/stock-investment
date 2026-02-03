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
  previousClose: string; // 昨日收盘
  updateTime: string;
}

// 股票数据项
class StockItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly description?: string,
    public readonly iconPath?: vscode.ThemeIcon,
    public readonly stockCode?: string,
    public readonly isRoot: boolean = false
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.iconPath = iconPath;
    this.tooltip = ''; // 禁用 tooltip
    
    // 设置 contextValue，用于右键菜单的显示条件
    if (isRoot && stockCode) {
      this.contextValue = 'stockRoot';
    }
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
  private stockCodeList: string[] = [];
  private holdingShares: Map<string, number> = new Map(); // 存储持有股数
  private lastUpdateTime: string = '';

  constructor() {
    // 读取配置并获取数据
    this.loadStockCodes();
    this.fetchAllStockData();
  }

  // 加载股票代码配置
  private loadStockCodes(): void {
    // 默认显示上证指数
    this.stockCodeList = ["1.000001"];
    this.holdingShares.clear();

    // 读取用户配置的股票代码
    const config = vscode.workspace.getConfiguration("stockInvestment");
    const customCodes = config.get<string[]>("stockCodeList", []);

    if (customCodes && customCodes.length > 0) {
      // 过滤掉空字符串
      const codes = customCodes
        .map((code) => code.trim())
        .filter((code) => code.length > 0);

      if (codes.length > 0) {
        // 解析股票代码和持有股数
        const parsedCodes: string[] = [];
        for (const code of codes) {
          // 支持 "市场.代码" 或 "市场.代码:持有股数" 格式
          const parts = code.split(":");
          const stockCode = parts[0].trim();
          
          if (stockCode) {
            parsedCodes.push(stockCode);
            
            // 如果配置了持有股数，保存到映射表
            if (parts.length > 1) {
              const shares = parseFloat(parts[1].trim());
              if (!isNaN(shares) && shares > 0) {
                this.holdingShares.set(stockCode, shares);
              }
            }
          }
        }

        // 使用自定义股票代码
        this.stockCodeList = parsedCodes;
      }
    }

    console.log("加载的股票代码:", this.stockCodeList);
    console.log("持有股数映射:", Array.from(this.holdingShares.entries()));
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
          new vscode.ThemeIcon("loading~spin"),
          "1.000001",
          true
        ),
      ];
    }

    const items: StockItem[] = [];

    // 按照配置顺序显示股票
    for (const code of this.stockCodeList) {
      const stockData = this.stocksData.get(code);

      if (!stockData) {
        items.push(
          new StockItem(
            code,
            vscode.TreeItemCollapsibleState.Collapsed,
            "加载失败",
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

      // 根据市场代码添加标识和图标
      let marketTag = '';
      let iconColor: string | undefined = 'charts.green';
      const marketCode = code.split('.')[0];
      const stockCode = code.split('.')[1];
      
      if (marketCode === '116') {
        // 港股 - 紫色
        marketTag = ' ［港］';
        iconColor = 'charts.purple';
      } else if (marketCode === '105' || marketCode === '106' || marketCode === '107') {
        // 美股 - 蓝色
        marketTag = ' ［美］';
        iconColor = 'charts.blue';
      } else if (marketCode === '0' && stockCode.startsWith('3')) {
        // A股创业板 - 橙色
        marketTag = ' ［创］';
        iconColor = 'charts.orange';
      } else if (marketCode === '1' && stockCode.startsWith('688')) {
        // A股科创板 - 黄色
        marketTag = ' ［科］';
        iconColor = 'charts.yellow';
      }

      const icon = iconColor 
        ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(iconColor))
        : undefined;

      items.push(
        new StockItem(
          name,
          vscode.TreeItemCollapsibleState.Collapsed,
          `${current} ${arrow} ${changePercent}%${marketTag}`,
          icon,
          code,
          true
        )
      );
    }

    // 计算今日总盈亏（仅统计有持仓的股票）
    let totalProfitLoss = 0;
    let hasHoldings = false;
    
    for (const [code, shares] of this.holdingShares.entries()) {
      const stockData = this.stocksData.get(code);
      if (stockData && shares > 0) {
        hasHoldings = true;
        const changeNum = parseFloat(stockData.change);
        totalProfitLoss += changeNum * shares;
      }
    }

    // 如果有持仓，在更新时间上方显示总盈亏
    if (hasHoldings) {
      const totalProfitLossStr = totalProfitLoss >= 0 
        ? `+${totalProfitLoss.toFixed(2)}` 
        : totalProfitLoss.toFixed(2);
      
      items.push(
        new StockItem(
          "今日盈亏",
          vscode.TreeItemCollapsibleState.None,
          totalProfitLossStr,
          new vscode.ThemeIcon(
            totalProfitLoss >= 0 ? "arrow-up" : "arrow-down",
            new vscode.ThemeColor(totalProfitLoss >= 0 ? "charts.red" : "charts.green")
          )
        )
      );
    }

    // 添加更新时间到列表末尾
    if (this.lastUpdateTime) {
      items.push(
        new StockItem(
          "更新时间",
          vscode.TreeItemCollapsibleState.None,
          this.lastUpdateTime,
          new vscode.ThemeIcon("clock")
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

    const { name, current, change, changePercent, previousClose, updateTime } = stockData;
    const changeNum = parseFloat(change);
    const isUp = changeNum >= 0;
    const arrow = isUp ? "↑" : "↓";

    const items: StockItem[] = [
      new StockItem(
        "昨日收盘",
        vscode.TreeItemCollapsibleState.None,
        previousClose,
        new vscode.ThemeIcon(
          "symbol-number",
          new vscode.ThemeColor("charts.blue")
        )
      ),
      new StockItem(
        "涨跌点数",
        vscode.TreeItemCollapsibleState.None,
        `${arrow} ${change}`,
        new vscode.ThemeIcon(
          isUp ? "arrow-up" : "arrow-down",
          new vscode.ThemeColor(isUp ? "charts.red" : "charts.green")
        )
      ),
    ];

    // 如果配置了持有股数，显示持仓信息
    const shares = this.holdingShares.get(stockCode);
    if (shares) {
      // 持有股数
      items.push(
        new StockItem(
          "持有股数",
          vscode.TreeItemCollapsibleState.None,
          `${shares}`,
          new vscode.ThemeIcon(
            "database",
            new vscode.ThemeColor("charts.purple")
          )
        )
      );

      // 今日盈亏 = 涨跌点数 × 持有股数
      const profitLoss = changeNum * shares;
      const profitLossStr = profitLoss >= 0 
        ? `+${profitLoss.toFixed(2)}` 
        : profitLoss.toFixed(2);
      
      items.push(
        new StockItem(
          "今日盈亏",
          vscode.TreeItemCollapsibleState.None,
          profitLossStr,
          new vscode.ThemeIcon(
            profitLoss >= 0 ? "arrow-up" : "arrow-down",
            new vscode.ThemeColor(profitLoss >= 0 ? "charts.red" : "charts.green")
          )
        )
      );
    }

    return items;
  }

  // 获取所有股票数据（批量方式）
  private fetchAllStockData(): void {
    if (this.stockCodeList.length === 0) {
      this.isLoading = false;
      this._onDidChangeTreeData.fire();
      return;
    }

    const updateTime = new Date().toLocaleTimeString("zh-CN");
    this.lastUpdateTime = updateTime; // 保存最后更新时间

    // 清空旧数据
    this.stocksData.clear();

    // 批量获取股票数据
    this.fetchBatchStocks(this.stockCodeList, updateTime, () => {
      this.isLoading = false;
      this._onDidChangeTreeData.fire();
    });
  }

  // 批量获取股票数据
  private fetchBatchStocks(
    stockCodeList: string[],
    updateTime: string,
    callback: () => void
  ): void {
    // 使用批量查询API，一次性获取所有股票数据
    const secids = stockCodeList.join(",");
    const url = `http://push2.eastmoney.com/api/qt/ulist.np/get?secids=${secids}&fields=f12,f13,f14,f2,f4,f3,f18`;

    console.log(`批量获取 ${stockCodeList.length} 只股票数据`);

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

                // 批量查询API返回的数据需要除以100（A股）或除以1000（港股、美股）
                // 港股市场代码：116，美股市场代码：105、106、107
                const isHKorUS = marketCode === 116 || marketCode === 105 || marketCode === 106 || marketCode === 107;
                const divisor = isHKorUS ? 1000 : 100;
                const decimals = isHKorUS ? 3 : 2;
                
                const current = (stockData.f2 / divisor).toFixed(decimals);
                const changePercent = (stockData.f3 / 100).toFixed(2);
                const change = (stockData.f4 / divisor).toFixed(decimals);
                const previousClose = (stockData.f18 / divisor).toFixed(decimals);

                console.log(
                  `解析股票 ${stockCode}: 名称=${name}, 价格=${current}, 昨收=${previousClose}, 涨跌=${change}, 涨跌幅=${changePercent}%`
                );

                this.stocksData.set(stockCode, {
                  code: stockCode,
                  name,
                  current,
                  change,
                  changePercent,
                  previousClose,
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

  // 更新持有股数
  async updateHoldingShares(stockCode: string, shares: number): Promise<void> {
    const config = vscode.workspace.getConfiguration("stockInvestment");
    const customCodes = config.get<string[]>("stockCodeList", []);
    
    // 创建新的配置数组
    const newCodes: string[] = [];
    let found = false;
    
    for (const code of customCodes) {
      const trimmedCode = code.trim();
      if (!trimmedCode) {
        continue;
      }
      
      // 解析股票代码（去掉可能存在的持有股数）
      const parts = trimmedCode.split(":");
      const codeOnly = parts[0].trim();
      
      if (codeOnly === stockCode) {
        found = true;
        // 如果股数大于0，添加带股数的配置；否则只添加代码
        if (shares > 0) {
          newCodes.push(`${stockCode}:${shares}`);
        } else {
          newCodes.push(stockCode);
        }
      } else {
        // 保持原有配置不变
        newCodes.push(trimmedCode);
      }
    }
    
    // 如果没有找到该股票代码，且股数大于0，则添加新配置
    if (!found && shares > 0) {
      newCodes.push(`${stockCode}:${shares}`);
    }
    
    // 更新配置
    await config.update(
      "stockCodeList",
      newCodes,
      vscode.ConfigurationTarget.Global
    );
    
    // 刷新视图
    this.refresh();
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
      if (e.affectsConfiguration("stockInvestment.stockCodeList")) {
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
      // 确保 stockView 可见（即使被隐藏）
      await vscode.commands.executeCommand("stockView.focus");
    }
  );

  // 注册编辑持有股数命令
  const editHoldingSharesCommand = vscode.commands.registerCommand(
    "stockView.editHoldingShares",
    async (item: StockItem) => {
      if (!item || !item.stockCode) {
        vscode.window.showErrorMessage("无法获取股票代码");
        return;
      }

      const stockCode = item.stockCode;
      const stockName = item.label;
      
      // 获取当前持有股数（如果有）
      const config = vscode.workspace.getConfiguration("stockInvestment");
      const customCodes = config.get<string[]>("stockCodeList", []);
      let currentShares = 0;
      
      for (const code of customCodes) {
        const parts = code.trim().split(":");
        if (parts[0].trim() === stockCode && parts.length > 1) {
          const shares = parseFloat(parts[1].trim());
          if (!isNaN(shares) && shares > 0) {
            currentShares = shares;
          }
          break;
        }
      }

      // 显示输入框
      const input = await vscode.window.showInputBox({
        prompt: `请输入 ${stockName} (${stockCode}) 的持有股数`,
        placeHolder: "输入大于等于0的整数，输入0或留空表示清除持仓",
        value: currentShares > 0 ? currentShares.toString() : "",
        validateInput: (value: string) => {
          if (value.trim() === "") {
            return null; // 允许空值（表示清除）
          }
          
          const num = parseFloat(value);
          
          // 检查是否为有效数字
          if (isNaN(num)) {
            return "请输入有效的数字";
          }
          
          // 检查是否为非负数
          if (num < 0) {
            return "持有股数不能为负数";
          }
          
          // 检查是否为整数
          if (!Number.isInteger(num)) {
            return "请输入整数";
          }
          
          return null;
        }
      });

      // 用户取消输入
      if (input === undefined) {
        return;
      }

      // 解析输入值
      const shares = input.trim() === "" ? 0 : parseInt(input.trim(), 10);

      // 更新持有股数
      await stockDataProvider.updateHoldingShares(stockCode, shares);

      // 显示成功消息
      if (shares > 0) {
        vscode.window.showInformationMessage(
          `已设置 ${stockName} 持有股数为 ${shares}`
        );
      } else {
        vscode.window.showInformationMessage(
          `已清除 ${stockName} 的持仓配置`
        );
      }
    }
  );

  // 添加到订阅列表
  context.subscriptions.push(
    treeView,
    configChangeListener,
    refreshCommand,
    openWebsiteCommand,
    openPanelCommand,
    editHoldingSharesCommand
  );
}

export function deactivate() {
  // 清理资源
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = undefined;
  }
}
