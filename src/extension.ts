import * as vscode from 'vscode';
import * as http from 'http';

let updateInterval: NodeJS.Timeout | undefined;

// 股票数据项
class StockItem extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly description?: string,
		public readonly tooltip?: string,
		public readonly iconPath?: vscode.ThemeIcon,
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
	private _onDidChangeTreeData: vscode.EventEmitter<StockItem | undefined | null | void> = new vscode.EventEmitter<StockItem | undefined | null | void>();
	readonly onDidChangeTreeData: vscode.Event<StockItem | undefined | null | void> = this._onDidChangeTreeData.event;

	private stockData: any = null;
	private isLoading: boolean = true;

	constructor() {
		// 立即获取一次数据
		this.fetchStockData();
	}

	// 刷新视图
	refresh(): void {
		this.fetchStockData();
	}

	// 获取树节点
	getTreeItem(element: StockItem): vscode.TreeItem {
		return element;
	}

	// 获取子节点
	getChildren(element?: StockItem): Thenable<StockItem[]> {
		if (!element) {
			// 根节点 - 显示上证指数
			return Promise.resolve(this.getRootItems());
		} else if (element.isRoot) {
			// 展开根节点 - 显示详细数据
			return Promise.resolve(this.getDetailItems());
		}
		return Promise.resolve([]);
	}

	// 获取根节点（上证指数）
	private getRootItems(): StockItem[] {
		if (this.isLoading) {
			return [
				new StockItem(
					'上证指数',
					vscode.TreeItemCollapsibleState.Collapsed,
					'加载中...',
					'正在获取股票数据',
					new vscode.ThemeIcon('loading~spin'),
					true
				)
			];
		}

		if (!this.stockData) {
			return [
				new StockItem(
					'上证指数',
					vscode.TreeItemCollapsibleState.Collapsed,
					'加载失败',
					'点击刷新按钮重试',
					new vscode.ThemeIcon('error'),
					true
				)
			];
		}

		const { current, change, changePercent } = this.stockData;
		const changeNum = parseFloat(change);
		const isUp = changeNum >= 0;
		const arrow = isUp ? '↑' : '↓';

		return [
			new StockItem(
				'上证指数',
				vscode.TreeItemCollapsibleState.Collapsed,
				`${current} ${arrow}${changePercent}%`,
				`当前: ${current} 点\n涨跌: ${arrow} ${change} (${changePercent}%)\n点击展开查看详情`,
				new vscode.ThemeIcon('graph-line', new vscode.ThemeColor(isUp ? 'charts.green' : 'charts.red')),
				true
			)
		];
	}

	// 获取详细数据项
	private getDetailItems(): StockItem[] {
		if (!this.stockData) {
			return [];
		}

		const { name, current, change, changePercent, updateTime } = this.stockData;
		const changeNum = parseFloat(change);
		const isUp = changeNum >= 0;
		const arrow = isUp ? '↑' : '↓';

		return [
			new StockItem(
				'当前点数',
				vscode.TreeItemCollapsibleState.None,
				current,
				`${name} 当前点数: ${current}`,
				new vscode.ThemeIcon('symbol-number', new vscode.ThemeColor('charts.blue'))
			),
			new StockItem(
				'涨跌点数',
				vscode.TreeItemCollapsibleState.None,
				`${arrow} ${change}`,
				`涨跌点数: ${change}`,
				new vscode.ThemeIcon(isUp ? 'arrow-up' : 'arrow-down', new vscode.ThemeColor(isUp ? 'charts.green' : 'charts.red'))
			),
			new StockItem(
				'涨跌幅',
				vscode.TreeItemCollapsibleState.None,
				`${arrow} ${changePercent}%`,
				`涨跌幅: ${changePercent}%`,
				new vscode.ThemeIcon(isUp ? 'trending-up' : 'trending-down', new vscode.ThemeColor(isUp ? 'charts.green' : 'charts.red'))
			),
			new StockItem(
				'更新时间',
				vscode.TreeItemCollapsibleState.None,
				updateTime,
				`最后更新: ${updateTime}`,
				new vscode.ThemeIcon('clock')
			)
		];
	}

	// 获取股票数据
	private fetchStockData(): void {
		const url = 'http://push2.eastmoney.com/api/qt/stock/get?secid=1.000001&fields=f43,f58,f169,f170';

		http.get(url, (res) => {
			let data = '';

			res.on('data', (chunk) => {
				data += chunk;
			});

			res.on('end', () => {
				try {
					console.log('data====>', data);
					const jsonData = JSON.parse(data);
					
					if (jsonData && jsonData.data) {
						const stockData = jsonData.data;
						const name = stockData.f58 || '上证指数';
						const current = (stockData.f43 / 100).toFixed(2);
						const changePercent = (stockData.f170 / 100).toFixed(2);
						const change = (stockData.f169 / 100).toFixed(2);
						const updateTime = new Date().toLocaleTimeString('zh-CN');

						this.stockData = { name, current, change, changePercent, updateTime };
						this.isLoading = false;
						
						// 刷新树视图
						this._onDidChangeTreeData.fire();
					}
				} catch (error) {
					console.error('解析错误:', error);
					this.isLoading = false;
					this.stockData = null;
					this._onDidChangeTreeData.fire();
				}
			});
		}).on('error', (error) => {
			console.error('获取数据失败:', error);
			this.isLoading = false;
			this.stockData = null;
			this._onDidChangeTreeData.fire();
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
			this.fetchStockData();
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
	const treeView = vscode.window.createTreeView('stockView', {
		treeDataProvider: stockDataProvider,
		showCollapseAll: false
	});

	// 启动自动更新（每3秒更新一次）
	stockDataProvider.startAutoUpdate(3000);

	// 注册刷新命令
	const refreshCommand = vscode.commands.registerCommand('stockView.refresh', () => {
		stockDataProvider.refresh();
	});

	// 注册打开网站命令
	const openWebsiteCommand = vscode.commands.registerCommand('stockView.openWebsite', () => {
		vscode.env.openExternal(vscode.Uri.parse('https://www.eastmoney.com/'));
	});

	// 保留原有的命令（兼容性）
	const openPanelCommand = vscode.commands.registerCommand('extension.showStockPanel', async () => {
		// 显示资源管理器侧边栏
		await vscode.commands.executeCommand('workbench.view.explorer');
	});

	// 添加到订阅列表
	context.subscriptions.push(
		treeView,
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
