/**
 * ChatGPT Chat Navigator - ChatGPT 对话目录导航插件
 * 为 ChatGPT 对话提供目录面板，支持快速跳转到任意问答位置
 */

(function () {
    'use strict';

    // ============================================================
    // 配置常量
    // ============================================================
    const CONFIG = {
        // DOM 选择器
        SELECTORS: {
            // 消息轮次容器
            TURN: '[data-testid^="conversation-turn-"]',
            // 用户消息
            USER_MESSAGE: '[data-message-author-role="user"]',
            // 助手消息
            ASSISTANT_MESSAGE: '[data-message-author-role="assistant"]',
            // 滚动容器
            SCROLL_CONTAINER: '[data-scroll-root]',
            // 消息内容 - 用户
            USER_CONTENT: '.whitespace-pre-wrap',
            // 消息内容 - 助手
            ASSISTANT_CONTENT: '.markdown.prose',
            // 右上角按钮容器（Share 按钮所在的容器）
            HEADER_ACTIONS: 'div.flex.gap-2',
        },
        // 摘要最大字符数
        SUMMARY_MAX_LENGTH: 30,
        // Tooltip 最大字符数
        TOOLTIP_MAX_LENGTH: 150,
        // 重命名最大字符数
        RENAME_MAX_LENGTH: 50,
        // 面板宽度
        PANEL_WIDTH: 280,
        // 防抖延迟
        DEBOUNCE_DELAY: 200,
        // 节流延迟
        THROTTLE_DELAY: 100,
        // Tooltip 悬停延迟
        TOOLTIP_DELAY: 500,
        // 存储键前缀
        STORAGE_KEY: 'chatanchor_renames',
        // AI 摘要输入文本最大字符数
        AI_SUMMARY_MAX_LENGTH: 1000,
        // AI 摘要截断时首尾保留字符数
        AI_SUMMARY_HALF_LENGTH: 500,
    };

    // ============================================================
    // 工具函数
    // ============================================================

    /**
     * 防抖函数
     */
    function debounce(fn, delay) {
        let timer = null;
        return function (...args) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    /**
     * 节流函数
     */
    function throttle(fn, delay) {
        let lastTime = 0;
        return function (...args) {
            const now = Date.now();
            if (now - lastTime >= delay) {
                lastTime = now;
                fn.apply(this, args);
            }
        };
    }

    /**
     * 生成唯一 ID
     */
    function generateId() {
        return 'ca-' + Math.random().toString(36).substr(2, 9);
    }

    /**
     * 提取文本摘要
     */
    function extractSummary(element, maxLength = CONFIG.SUMMARY_MAX_LENGTH) {
        if (!element) return '(无内容)';
        const text = element.textContent?.trim() || '';
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength) + '...';
    }

    /**
     * 提取完整文本（用于 tooltip）
     */
    function extractFullText(element, maxLength = CONFIG.TOOLTIP_MAX_LENGTH) {
        if (!element) return '';
        const text = element.textContent?.trim() || '';
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength) + '...';
    }

    // ============================================================
    // 文本预处理器
    // ============================================================

    /**
     * 文本预处理器 - 将对话内容格式化为 AI 摘要所需的输入
     *
     * 扩展点说明：
     * - formatForSummarization 的 userTextReducer / assistantTextReducer 参数
     *   支持自定义文本缩减策略
     * - 当前默认策略为直接截断（truncateText）
     * - 未来可替换为 AI 摘要策略，例如：
     *   const aiReducer = async (text) => await aiService.summarize(text);
     *   TextPreprocessor.formatForSummarization({ ..., userTextReducer: aiReducer });
     */
    const TextPreprocessor = {
        /**
         * 默认文本缩减策略：直接截断
         * 超过 maxLength 时，保留首尾各 halfLength 个字符，中间用 "……" 连接
         */
        truncateText(text, maxLength = CONFIG.AI_SUMMARY_MAX_LENGTH, halfLength = CONFIG.AI_SUMMARY_HALF_LENGTH) {
            if (!text || text.length <= maxLength) return text || '';
            return text.substring(0, halfLength) + '……' + text.substring(text.length - halfLength);
        },

        /**
         * 从用户轮次 DOM 元素中提取对话对（用户提问 + AI 回答）
         */
        extractConversationPair(userTurnElement) {
            const userContent = userTurnElement.querySelector(CONFIG.SELECTORS.USER_CONTENT);
            const userText = userContent?.textContent?.trim() || '';

            let assistantText = '';
            const nextTurn = userTurnElement.nextElementSibling;
            if (nextTurn && nextTurn.matches(CONFIG.SELECTORS.TURN)) {
                const assistantContent = nextTurn.querySelector(CONFIG.SELECTORS.ASSISTANT_CONTENT);
                assistantText = assistantContent?.textContent?.trim() || '';
            }

            return { userText, assistantText };
        },

        /**
         * 格式化对话文本，用于发送给 AI 摘要
         * @param {Object} options
         * @param {string} options.userText - 用户提问文本
         * @param {string} options.assistantText - AI 回答文本
         * @param {Function} [options.userTextReducer] - 用户文本缩减策略（扩展点，可替换为 AI 摘要）
         * @param {Function} [options.assistantTextReducer] - AI 回答文本缩减策略（扩展点）
         * @returns {string} 格式化后的文本
         */
        formatForSummarization({ userText, assistantText, userTextReducer, assistantTextReducer }) {
            const uReducer = userTextReducer || this.truncateText.bind(this);
            const aReducer = assistantTextReducer || this.truncateText.bind(this);

            const processedUser = uReducer(userText);
            const processedAssistant = aReducer(assistantText);

            return `User's Prompt:\n${processedUser}\nChatGPT's Answer:\n${processedAssistant}`;
        },
    };

    // ============================================================
    // AI 摘要服务
    // ============================================================

    /**
     * AI 摘要服务 - 通过 background service worker 调用后端代理
     */
    const AISummarizerService = {
        /**
         * 检查服务是否可用
         */
        async isAvailable() {
            return typeof chrome !== 'undefined' && !!chrome.runtime?.sendMessage;
        },

        /**
         * 对文本进行摘要（通过后端代理调用 Qwen API）
         */
        async summarize(text) {
            return new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({ type: 'AI_SUMMARIZE', text }, (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    if (response?.error) {
                        reject(new Error(response.error));
                        return;
                    }
                    resolve(response?.summary || '');
                });
            });
        },
    };

    // ============================================================
    // 目录数据管理
    // ============================================================
    class TocManager {
        constructor() {
            this.items = [];
            this.activeItemId = null;
        }

        /**
         * 扫描页面消息并生成目录
         * 每个目录项对应一次问答（Q+A 组合）
         */
        scan() {
            const turns = document.querySelectorAll(CONFIG.SELECTORS.TURN);
            const newItems = [];
            let qaIndex = 0;

            for (let i = 0; i < turns.length; i++) {
                const turn = turns[i];
                const dataTurn = turn.getAttribute('data-turn');
                const isUser = dataTurn === 'user' || turn.querySelector(CONFIG.SELECTORS.USER_MESSAGE);

                // 只处理用户消息，作为问答对的起点
                if (!isUser) continue;

                qaIndex++;
                const turnId = turn.getAttribute('data-testid') || generateId();

                // 提取用户问题摘要和完整内容
                const contentElement = turn.querySelector(CONFIG.SELECTORS.USER_CONTENT);
                const summary = extractSummary(contentElement);
                const fullText = extractFullText(contentElement);

                newItems.push({
                    id: turnId,
                    index: qaIndex,
                    type: 'qa',
                    summary,
                    fullText, // 用于 tooltip 显示
                    element: turn, // 定位到用户提问位置
                });
            }

            this.items = newItems;
            return this.items;
        }

        /**
         * 获取所有目录项
         */
        getItems() {
            return this.items;
        }

        /**
         * 设置当前活跃的目录项
         */
        setActiveItem(id) {
            this.activeItemId = id;
        }

        /**
         * 获取当前活跃的目录项 ID
         */
        getActiveItemId() {
            return this.activeItemId;
        }
    }

    // ============================================================
    // 目录面板 UI
    // ============================================================
    class TocPanel {
        constructor(tocManager) {
            this.tocManager = tocManager;
            this.panel = null;
            this.listContainer = null;
            this.searchInput = null;
            this.isCollapsed = false;
            this.searchTerm = '';
            this.isScrolling = false;      // 滚动状态标记
            this.scrollTargetId = null;    // 目标目录项 ID
            this.scrollEndTimer = null;    // 滚动结束检测计时器
            this.boundScrollEndHandler = null; // 滚动结束处理函数引用
            this.jumpTargetId = null;      // 跳转目标 ID（小绿点指示）
            this.tooltip = null;           // Tooltip 元素
            this.tooltipTimer = null;      // Tooltip 延迟计时器
            this.customNames = {};         // 自定义名称缓存
            this.editingItemId = null;     // 当前正在编辑的项目 ID
            this.summarizingItemId = null; // 当前正在 AI 摘要的项目 ID
            this.conversationId = this.getConversationId(); // 当前对话 ID
        }

        /**
         * 获取当前对话 ID
         */
        getConversationId() {
            // 从 URL 提取对话 ID，如 /c/abc123
            const match = window.location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
            return match ? match[1] : 'default';
        }

        /**
         * 加载自定义名称
         */
        async loadCustomNames() {
            try {
                const result = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
                const allRenames = result[CONFIG.STORAGE_KEY] || {};
                this.customNames = allRenames[this.conversationId] || {};
                this.render(); // 加载完成后更新 UI
            } catch (e) {
                console.warn('ChatGPT Chat Navigator: 加载自定义名称失败', e);
                this.customNames = {};
            }
        }

        /**
         * 保存自定义名称
         */
        async saveCustomName(itemId, newName) {
            try {
                const result = await chrome.storage.local.get(CONFIG.STORAGE_KEY);
                const allRenames = result[CONFIG.STORAGE_KEY] || {};

                if (!allRenames[this.conversationId]) {
                    allRenames[this.conversationId] = {};
                }

                if (newName && newName.trim()) {
                    allRenames[this.conversationId][itemId] = newName.trim();
                    this.customNames[itemId] = newName.trim();
                } else {
                    // 空名称则删除自定义名称
                    delete allRenames[this.conversationId][itemId];
                    delete this.customNames[itemId];
                }

                await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: allRenames });
            } catch (e) {
                console.warn('ChatGPT Chat Navigator: 保存自定义名称失败', e);
            }
        }

        /**
         * 获取显示名称（自定义名称优先）
         */
        getDisplayName(item) {
            return this.customNames[item.id] || item.summary;
        }

        /**
         * 创建面板 DOM
         */
        create() {
            // 检查是否已存在
            if (document.getElementById('chatanchor-panel')) {
                this.panel = document.getElementById('chatanchor-panel');
                this.listContainer = this.panel.querySelector('.ca-list');
                this.searchInput = this.panel.querySelector('.ca-search-input');
                return;
            }

            // 创建面板容器
            this.panel = document.createElement('div');
            this.panel.id = 'chatanchor-panel';

            // 注入图标路径 CSS 变量，确保路径正确
            try {
                this.panel.style.setProperty('--ca-icon-rename', `url('${chrome.runtime.getURL('icons/rename.svg')}')`);
                this.panel.style.setProperty('--ca-icon-ai', `url('${chrome.runtime.getURL('icons/ai_sumarize.svg')}')`);
                this.panel.style.setProperty('--ca-icon-hide', `url('${chrome.runtime.getURL('icons/hide.svg')}')`);
            } catch (e) {
                console.warn('ChatGPT Chat Navigator: 设置图标路径失败', e);
            }
            this.panel.innerHTML = `
        <div class="ca-header">
          <div class="ca-title">
            <svg class="ca-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 6h16M4 12h16M4 18h10"/>
            </svg>
            <span>对话目录</span>
          </div>
          <div class="ca-header-actions">
            <button class="ca-btn ca-btn-collapse" title="折叠面板"></button>
          </div>
        </div>
        <div class="ca-search">
          <div class="ca-search-wrap">
            <input type="text" class="ca-search-input" placeholder="搜索消息...">
            <button class="ca-search-clear" title="清空搜索">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="ca-list"></div>
      `;

            // 创建折叠时的按钮（ChatGPT 风格）
            this.collapseBtn = document.createElement('button');
            this.collapseBtn.id = 'chatanchor-expand-btn';
            this.collapseBtn.className = 'ca-expand-btn';
            this.collapseBtn.title = '展开目录';
            this.collapseBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 6h16M4 12h16M4 18h10"/>
        </svg>
      `;
            this.collapseBtn.style.display = 'flex';

            // 将面板插入到 ChatGPT 主内容区的 flex 容器中（作为右侧边栏）
            this.insertPanelIntoLayout();

            // 将折叠按钮插入到 ChatGPT 右上角按钮容器
            this.insertExpandButton();

            // 获取引用
            this.listContainer = this.panel.querySelector('.ca-list');
            this.searchInput = this.panel.querySelector('.ca-search-input');

            // 绑定事件
            this.bindEvents();

            // 恢复折叠状态
            this.restoreState();
        }

        /**
         * 将展开按钮插入到 ChatGPT 右上角
         */
        insertExpandButton() {
            // 查找 ChatGPT 右上角的按钮容器
            const headerActions = document.getElementById('conversation-header-actions');

            if (headerActions) {
                // 如果按钮已在正确位置，跳过
                if (this.collapseBtn.parentElement === headerActions) return;
                // 插入到容器的第一个位置（Share 按钮左侧）
                headerActions.insertBefore(this.collapseBtn, headerActions.firstChild);
            } else if (!this.collapseBtn.parentElement) {
                // 降级方案：添加到 body
                console.warn('ChatGPT Chat Navigator: 未找到右上角按钮容器，使用降级方案');
                document.body.appendChild(this.collapseBtn);
            }
        }

        /**
         * 将面板插入到 ChatGPT 页面布局中（侧边栏模式）
         * 找到主内容区的 flex 容器，将面板作为其最后一个子元素插入，
         * 利用 flex 布局自动压缩主内容区宽度
         */
        insertPanelIntoLayout() {
            // 查找主内容区域（包含 data-scroll-root 的容器的父级 @container/main）
            const scrollRoot = document.querySelector('[data-scroll-root]');
            const mainContainer = scrollRoot?.closest('[class*="@container/main"]');
            const flexParent = mainContainer?.parentElement;

            if (flexParent && this.panel.parentElement !== flexParent) {
                flexParent.appendChild(this.panel);
            } else if (!flexParent && !this.panel.parentElement) {
                // 降级方案：添加到 body
                console.warn('ChatGPT Chat Navigator: 未找到主内容 flex 容器，面板添加到 body');
                document.body.appendChild(this.panel);
            }
        }

        /**
         * 绑定事件
         */
        bindEvents() {
            // 折叠按钮
            const collapseBtn = this.panel.querySelector('.ca-btn-collapse');
            collapseBtn.addEventListener('click', () => {
                this.toggleCollapse();
            });

            // 展开按钮
            this.collapseBtn.addEventListener('click', () => {
                this.toggleCollapse();
            });

            // 搜索输入
            this.searchInput.addEventListener(
                'input',
                debounce((e) => {
                    this.searchTerm = e.target.value.toLowerCase();
                    this.render();
                }, CONFIG.DEBOUNCE_DELAY)
            );

            // 搜索清空按钮
            this.panel.querySelector('.ca-search-clear').addEventListener('click', () => {
                this.searchInput.value = '';
                this.searchTerm = '';
                this.render();
                this.searchInput.focus();
            });

            // 目录项点击 - 使用 mousedown 比 click 更快响应
            this.listContainer.addEventListener('mousedown', (e) => {
                // 只响应左键点击
                if (e.button !== 0) return;

                // 如果点击的是重命名相关按钮或输入框，不处理滚动
                if (e.target.closest('.ca-rename-btn') ||
                    e.target.closest('.ca-item-rename-btn') ||
                    e.target.closest('.ca-item-ai-btn') ||
                    e.target.closest('.ca-rename-input')) {
                    return;
                }

                const item = e.target.closest('.ca-item');
                if (item && item.dataset.id && !item.classList.contains('ca-item-editing')) {
                    e.preventDefault();
                    e.stopPropagation();
                    // 点击时隐藏预览文字
                    this.hideTooltip();
                    this.currentHoverId = null;
                    const id = item.dataset.id;
                    this.scrollToItem(id);
                }
            });

            // AI 摘要按钮和重命名按钮点击
            this.listContainer.addEventListener('click', (e) => {
                // 点击 AI 摘要按钮
                if (e.target.closest('.ca-item-ai-btn')) {
                    e.preventDefault();
                    e.stopPropagation();
                    const item = e.target.closest('.ca-item');
                    if (item && item.dataset.id) {
                        this.aiSummarize(item.dataset.id);
                    }
                    return;
                }

                // 点击重命名按钮
                if (e.target.closest('.ca-item-rename-btn')) {
                    e.preventDefault();
                    e.stopPropagation();
                    const item = e.target.closest('.ca-item');
                    if (item && item.dataset.id) {
                        this.startRename(item.dataset.id);
                    }
                    return;
                }
            });

            // ESC 和 Enter 键处理
            this.listContainer.addEventListener('keydown', (e) => {
                if (e.target.classList.contains('ca-rename-input')) {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        this.cancelRename();
                    } else if (e.key === 'Enter') {
                        e.preventDefault();
                        this.confirmRename();
                    }
                }
            });

            // Tooltip 悬停事件 - 使用 data-id 追踪而非元素引用
            this.currentHoverId = null;

            this.listContainer.addEventListener('mouseover', (e) => {
                const item = e.target.closest('.ca-item');
                // 编辑模式下不显示 tooltip
                if (item && item.dataset.id && !item.classList.contains('ca-item-editing')) {
                    const id = item.dataset.id;
                    // 只有当悬停到新的项目时才重新计时
                    if (id !== this.currentHoverId) {
                        this.currentHoverId = id;
                        this.scheduleTooltip(item);
                    }
                }
            });

            this.listContainer.addEventListener('mouseout', (e) => {
                const relatedTarget = e.relatedTarget;
                // 检查是否移动到了另一个 item 或离开了列表
                const newItem = relatedTarget?.closest?.('.ca-item');
                const newId = newItem?.dataset?.id;

                // 如果移到了不同的 item 或离开列表，隐藏 tooltip
                if (newId !== this.currentHoverId) {
                    this.currentHoverId = null;
                    this.hideTooltip();
                }
            });
        }

        /**
         * 开始重命名
         */
        startRename(itemId) {
            this.editingItemId = itemId;
            this.hideTooltip();
            this.render();

            // 添加点击外部取消的监听器
            setTimeout(() => {
                this.clickOutsideHandler = (e) => {
                    const editingItem = this.listContainer.querySelector('.ca-item-editing');
                    if (editingItem && !editingItem.contains(e.target)) {
                        this.cancelRename();
                    }
                };
                document.addEventListener('mousedown', this.clickOutsideHandler);
            }, 0);
        }

        /**
         * 确认重命名
         */
        async confirmRename() {
            const input = this.listContainer.querySelector('.ca-rename-input');
            if (input && this.editingItemId) {
                const newName = input.value.trim().substring(0, CONFIG.RENAME_MAX_LENGTH);
                await this.saveCustomName(this.editingItemId, newName);
                this.editingItemId = null;
                // 移除点击外部监听器
                if (this.clickOutsideHandler) {
                    document.removeEventListener('mousedown', this.clickOutsideHandler);
                    this.clickOutsideHandler = null;
                }
                this.render();
            }
        }

        /**
         * 取消重命名
         */
        cancelRename() {
            this.editingItemId = null;
            // 移除点击外部监听器
            if (this.clickOutsideHandler) {
                document.removeEventListener('mousedown', this.clickOutsideHandler);
                this.clickOutsideHandler = null;
            }
            this.render();
        }

        /**
         * AI 摘要并自动重命名
         */
        async aiSummarize(itemId) {
            // 防止重复触发
            if (this.summarizingItemId) return;

            // 检查 AI 可用性
            const available = await AISummarizerService.isAvailable();
            if (!available) {
                console.warn('ChatGPT Chat Navigator: Summarizer API 不可用，请确保使用支持内置 AI 的 Chrome 浏览器');
                return;
            }

            // 查找对应的目录项
            const tocItem = this.tocManager.getItems().find((i) => i.id === itemId);
            if (!tocItem || !tocItem.element) return;

            // 设置摘要状态并更新 UI
            this.summarizingItemId = itemId;
            this.hideTooltip();
            this.render();

            try {
                // 提取对话内容
                const { userText, assistantText } = TextPreprocessor.extractConversationPair(tocItem.element);

                // 格式化文本
                const inputText = TextPreprocessor.formatForSummarization({ userText, assistantText });

                // 调用 AI 摘要
                const summary = await AISummarizerService.summarize(inputText);

                // 截取摘要结果到最大长度并保存
                const newName = (summary || '').trim().substring(0, CONFIG.RENAME_MAX_LENGTH);
                if (newName) {
                    await this.saveCustomName(itemId, newName);
                }
            } catch (e) {
                console.warn('ChatGPT Chat Navigator: AI 摘要失败', e);
            } finally {
                // 清除摘要状态并更新 UI
                this.summarizingItemId = null;
                this.render();
            }
        }

        /**
         * 渲染目录列表
         */
        render() {
            const items = this.tocManager.getItems();
            const activeId = this.tocManager.getActiveItemId();

            // 过滤搜索
            const filteredItems = this.searchTerm
                ? items.filter((item) => {
                    const term = this.searchTerm;
                    const original = item.summary.toLowerCase();
                    const custom = (this.customNames[item.id] || '').toLowerCase();
                    return original.includes(term) || custom.includes(term);
                })
                : items;

            // 生成列表 HTML
            const html = filteredItems
                .map((item) => {
                    const isActive = item.id === activeId;
                    const isJumpTarget = item.id === this.jumpTargetId;
                    const isEditing = item.id === this.editingItemId;
                    const displayName = this.getDisplayName(item);
                    const hasCustomName = this.customNames[item.id] ? true : false;

                    const isSummarizing = item.id === this.summarizingItemId;

                    if (isEditing) {
                        // 编辑模式
                        return `
          <div class="ca-item ca-item-editing" data-id="${item.id}">
            <input type="text" class="ca-rename-input" value="${this.escapeAttr(displayName)}" maxlength="${CONFIG.RENAME_MAX_LENGTH}" />
          </div>
        `;
                    } else if (isSummarizing) {
                        // AI 摘要中
                        return `
          <div class="ca-item ca-item-summarizing" data-id="${item.id}">
            <span class="ca-item-indicator"></span>
            <span class="ca-item-summary">AI 摘要中...</span>
            <span class="ca-item-ai-loading"></span>
          </div>
        `;
                    } else {
                        // 常规模式
                        return `
          <div class="ca-item ${isActive ? 'ca-item-active' : ''}" data-id="${item.id}" data-fulltext="${this.escapeAttr(item.fullText || '')}" data-original="${this.escapeAttr(item.summary)}">
            <span class="ca-item-indicator ${isJumpTarget ? 'ca-indicator-active' : ''}"></span>
            <span class="ca-item-summary ${hasCustomName ? 'ca-custom-name' : ''}">${this.escapeHtml(displayName)}</span>
            <button class="ca-item-ai-btn" title="AI 摘要"></button>
            <button class="ca-item-rename-btn" title="重命名"></button>
          </div>
        `;
                    }
                })
                .join('');

            const newHtml = html || '<div class="ca-empty">暂无消息</div>';
            // 跳过无变化的渲染，避免 MutationObserver 反馈循环导致 hover 闪烁
            if (newHtml === this._lastRenderedHtml) return;
            this._lastRenderedHtml = newHtml;
            this.listContainer.innerHTML = newHtml;

            // 如果有编辑中的项目，聚焦输入框
            if (this.editingItemId) {
                const input = this.listContainer.querySelector('.ca-rename-input');
                if (input) {
                    input.focus();
                    input.select();
                }
            }
        }

        /**
         * 转义 HTML 属性
         */
        escapeAttr(text) {
            return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        /**
         * 延迟显示 Tooltip
         */
        scheduleTooltip(itemEl) {
            // 只清除计时器，不清除已显示的 tooltip
            if (this.tooltipTimer) {
                clearTimeout(this.tooltipTimer);
                this.tooltipTimer = null;
            }

            const itemId = itemEl.dataset.id;

            this.tooltipTimer = setTimeout(() => {
                // 检查元素是否还存在且仍在悬停
                if (this.currentHoverId === itemId) {
                    // 重新获取元素（可能已被 render 替换）
                    const currentItem = this.listContainer.querySelector(`[data-id="${itemId}"]`);
                    if (currentItem) {
                        const fullText = currentItem.dataset.fulltext;
                        if (fullText && fullText.length > 0) {
                            this.showTooltip(currentItem, fullText);
                        }
                    }
                }
            }, CONFIG.TOOLTIP_DELAY);
        }

        /**
         * 显示 Tooltip
         */
        showTooltip(itemEl, text) {
            this.hideTooltip();

            this.tooltip = document.createElement('div');
            this.tooltip.className = 'ca-tooltip';
            this.tooltip.textContent = text;

            // 定位 Tooltip
            const rect = itemEl.getBoundingClientRect();
            const panelRect = this.panel.getBoundingClientRect();

            this.tooltip.style.left = `${rect.left - panelRect.left}px`;
            this.tooltip.style.top = `${rect.bottom - panelRect.top + 5}px`;
            this.tooltip.style.maxWidth = `${panelRect.width - 20}px`;

            this.panel.appendChild(this.tooltip);
        }

        /**
         * 隐藏 Tooltip
         */
        hideTooltip() {
            if (this.tooltipTimer) {
                clearTimeout(this.tooltipTimer);
                this.tooltipTimer = null;
            }
            if (this.tooltip) {
                this.tooltip.remove();
                this.tooltip = null;
            }
        }

        /**
         * 刷新目录
         */
        refresh() {
            // 检查对话 ID 是否变更（处理路由切换）
            const currentConvId = this.getConversationId();
            if (this.conversationId !== currentConvId) {
                // console.log(`ChatGPT Chat Navigator: 对话切换 ${this.conversationId} -> ${currentConvId}`);
                this.conversationId = currentConvId;
                this.loadCustomNames();
            }

            // 确保面板在正确的 DOM 位置（SPA 路由切换可能导致容器重建）
            this.insertPanelIntoLayout();
            // 确保展开按钮在正确的 DOM 位置（SPA 路由切换会重建 header）
            this.insertExpandButton();

            // 如果正在滚动、正在重命名或正在 AI 摘要，跳过刷新以避免干扰
            if (this.isScrolling || this.editingItemId || this.summarizingItemId) return;
            this.tocManager.scan();
            this.render();
        }

        /**
         * 滚动到指定项
         * 使用自定义滚动动画解决 content-visibility 导致的首次跳转不准问题：
         * 在动画每一帧中重新计算目标元素位置，确保即使布局变化也能准确定位
         */
        scrollToItem(id) {
            const item = this.tocManager.getItems().find((i) => i.id === id);
            if (!item || !item.element) return;

            // 设置滚动状态和目标 ID
            this.isScrolling = true;
            this.scrollTargetId = id;
            this.scrollTargetElement = item.element;

            // 立即设置跳转目标指示器（小绿点）
            this.jumpTargetId = id;
            this.updateJumpIndicator(id);

            // 获取滚动容器
            const scrollContainer = document.querySelector(CONFIG.SELECTORS.SCROLL_CONTAINER);
            if (!scrollContainer) return;

            // 取消之前的滚动动画
            if (this.scrollAnimationId) {
                cancelAnimationFrame(this.scrollAnimationId);
            }

            // 启动自定义滚动动画
            this.animateScrollToElement(item.element, scrollContainer);
        }

        /**
         * 自定义滚动动画
         * 在每一帧中重新计算目标位置，适应 content-visibility 导致的布局变化
         */
        animateScrollToElement(targetElement, scrollContainer) {
            const duration = 500; // 动画持续时间（毫秒）
            const startTime = performance.now();
            const startScrollTop = scrollContainer.scrollTop;

            // 计算目标位置
            const containerRect = scrollContainer.getBoundingClientRect();
            // 获取滚动容器的 scroll-padding-top（ChatGPT 用这个设置头部偏移）
            const containerStyle = window.getComputedStyle(scrollContainer);
            const scrollPaddingTop = parseFloat(containerStyle.scrollPaddingTop) || 0;

            const getTargetScrollTop = () => {
                const elementRect = targetElement.getBoundingClientRect();
                // 目标：让元素顶部对齐到 scroll-padding-top 的位置
                return scrollContainer.scrollTop + elementRect.top - containerRect.top - scrollPaddingTop + 20;
            };

            // 缓动函数：easeOutCubic，使滚动更自然
            const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

            const animate = (currentTime) => {
                const elapsed = currentTime - startTime;
                const progress = Math.min(elapsed / duration, 1);
                const easedProgress = easeOutCubic(progress);

                // 在每一帧中重新计算目标位置（关键：适应布局变化）
                const currentTargetScrollTop = getTargetScrollTop();

                // 计算当前帧应该滚动到的位置
                // 使用动态目标位置，而不是固定的初始目标位置
                const newScrollTop = startScrollTop + (currentTargetScrollTop - startScrollTop) * easedProgress;

                scrollContainer.scrollTop = newScrollTop;

                if (progress < 1) {
                    // 继续动画
                    this.scrollAnimationId = requestAnimationFrame(animate);
                } else {
                    // 动画结束，进行最终精确定位
                    const finalTargetScrollTop = getTargetScrollTop();
                    scrollContainer.scrollTop = finalTargetScrollTop;

                    // 清理动画 ID
                    this.scrollAnimationId = null;

                    // 触发滚动结束处理
                    this.onScrollAnimationEnd();
                }
            };

            // 开始动画
            this.scrollAnimationId = requestAnimationFrame(animate);
        }

        /**
         * 自定义滚动动画结束处理
         */
        onScrollAnimationEnd() {
            // 清理目标元素引用
            this.scrollTargetElement = null;

            // 更新高亮到目标项
            if (this.scrollTargetId) {
                this.updateActiveItemUI(this.scrollTargetId);
                this.tocManager.setActiveItem(this.scrollTargetId);
                this.scrollTargetId = null;
            }

            // 重置滚动状态
            this.isScrolling = false;
        }

        /**
         * 设置滚动结束检测
         * 使用防抖检测滚动是否真正停止（200ms 无新滚动事件）
         */
        setupScrollEndDetection(scrollContainer) {
            const scrollTarget = scrollContainer || window;

            // 清理之前的监听器
            if (this.boundScrollEndHandler) {
                scrollTarget.removeEventListener('scroll', this.boundScrollEndHandler);
            }
            if (this.scrollEndTimer) {
                clearTimeout(this.scrollEndTimer);
            }

            // 创建滚动结束处理函数
            this.boundScrollEndHandler = () => {
                // 每次滚动事件发生时，重置计时器
                if (this.scrollEndTimer) {
                    clearTimeout(this.scrollEndTimer);
                }

                // 200ms 内无新滚动事件，认为滚动已结束
                this.scrollEndTimer = setTimeout(() => {
                    this.onScrollEnd(scrollTarget);
                }, 200);
            };

            // 添加滚动监听
            scrollTarget.addEventListener('scroll', this.boundScrollEndHandler, { passive: true });

            // 立即触发一次检测（处理已经在目标位置的情况）
            this.boundScrollEndHandler();
        }

        /**
         * 滚动结束时的处理
         */
        onScrollEnd(scrollTarget) {
            // 移除滚动监听器
            if (this.boundScrollEndHandler) {
                scrollTarget.removeEventListener('scroll', this.boundScrollEndHandler);
                this.boundScrollEndHandler = null;
            }

            // 恢复目标元素的 scroll-margin-top 样式
            if (this.pendingScrollMarginRestore) {
                const { element, value } = this.pendingScrollMarginRestore;
                if (element) {
                    element.style.scrollMarginTop = value || '';
                }
                this.pendingScrollMarginRestore = null;
            }

            // 清理目标元素引用
            this.scrollTargetElement = null;

            // 现在才更新高亮到目标项
            if (this.scrollTargetId) {
                this.updateActiveItemUI(this.scrollTargetId);
                this.tocManager.setActiveItem(this.scrollTargetId);
                this.scrollTargetId = null;
            }

            // 重置滚动状态
            this.isScrolling = false;
        }

        /**
         * 更新跳转目标指示器（小绿点）
         */
        updateJumpIndicator(activeId) {
            // 移除旧的指示器
            const oldIndicator = this.listContainer.querySelector('.ca-indicator-active');
            if (oldIndicator) {
                oldIndicator.classList.remove('ca-indicator-active');
            }
            // 添加新的指示器
            const newItem = this.listContainer.querySelector(`[data-id="${activeId}"] .ca-item-indicator`);
            if (newItem) {
                newItem.classList.add('ca-indicator-active');
            }
        }

        /**
         * 通过 DOM 操作更新活跃项 UI（避免完整重新渲染）
         */
        updateActiveItemUI(activeId) {
            // 移除旧的活跃状态
            const oldActive = this.listContainer.querySelector('.ca-item-active');
            if (oldActive) {
                oldActive.classList.remove('ca-item-active');
            }
            // 添加新的活跃状态
            const newActive = this.listContainer.querySelector(`[data-id="${activeId}"]`);
            if (newActive) {
                newActive.classList.add('ca-item-active');
            }
        }

        /**
         * 切换折叠状态
         */
        toggleCollapse() {
            this.isCollapsed = !this.isCollapsed;
            this.panel.classList.toggle('ca-collapsed', this.isCollapsed);
            // 按钮始终显示
            this.collapseBtn.style.display = 'flex';
            this.saveState();
        }

        /**
         * 保存状态
         */
        saveState() {
            try {
                localStorage.setItem('chatanchor-collapsed', JSON.stringify(this.isCollapsed));
            } catch (e) {
                console.warn('ChatGPT Chat Navigator: 无法保存状态', e);
            }
        }

        /**
         * 恢复状态
         */
        restoreState() {
            try {
                const collapsed = localStorage.getItem('chatanchor-collapsed');
                if (collapsed) {
                    this.isCollapsed = JSON.parse(collapsed);
                    if (this.isCollapsed) {
                        this.panel.classList.add('ca-collapsed');
                        this.collapseBtn.style.display = 'flex';
                    }
                }
            } catch (e) {
                console.warn('ChatGPT Chat Navigator: 无法恢复状态', e);
            }
        }

        /**
         * 更新活跃项（基于滚动位置）
         */
        updateActiveByScroll() {
            // 如果正在用户触发的滚动动画中，跳过更新以避免高亮闪烁
            if (this.isScrolling) return;

            const items = this.tocManager.getItems();
            if (items.length === 0) return;

            // 找到当前视口中最靠近顶部的消息
            let activeItem = null;
            const viewportTop = window.scrollY || document.documentElement.scrollTop;
            const offset = 150; // 偏移量，考虑 header

            for (const item of items) {
                if (!item.element) continue;
                const rect = item.element.getBoundingClientRect();
                // 如果元素顶部在视口上方或刚进入视口
                if (rect.top <= offset) {
                    activeItem = item;
                } else {
                    break;
                }
            }

            if (activeItem && activeItem.id !== this.tocManager.getActiveItemId()) {
                this.tocManager.setActiveItem(activeItem.id);
                this.render();

                // 滚动目录列表使活跃项可见
                const activeEl = this.listContainer.querySelector('.ca-item-active');
                if (activeEl) {
                    activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                }
            }
        }

        /**
         * HTML 转义
         */
        escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    }

    // ============================================================
    // 主程序
    // ============================================================
    class ChatGPTChatNavigator {
        constructor() {
            this.tocManager = new TocManager();
            this.tocPanel = new TocPanel(this.tocManager);
            this.observer = null;
            this.scrollHandler = null;
        }

        /**
         * 初始化
         */
        init() {
            // 等待页面加载完成
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => this.setup());
            } else {
                this.setup();
            }
        }

        /**
         * 设置
         */
        async setup() {
            // 延迟执行以确保 ChatGPT 页面完全加载
            setTimeout(async () => {
                this.tocPanel.create();
                await this.tocPanel.loadCustomNames();
                this.tocPanel.refresh();
                this.setupObserver();
                this.setupScrollListener();
                console.log('ChatGPT Chat Navigator: 初始化完成');
            }, 1000);
        }

        /**
         * 设置 MutationObserver 监听 DOM 变化
         */
        setupObserver() {
            const target = document.body;

            this.observer = new MutationObserver(
                debounce(() => {
                    this.tocPanel.refresh();
                }, CONFIG.DEBOUNCE_DELAY * 2)
            );

            this.observer.observe(target, {
                childList: true,
                subtree: true,
            });
        }

        /**
         * 设置滚动监听
         */
        setupScrollListener() {
            // 尝试找到滚动容器
            const scrollContainer =
                document.querySelector(CONFIG.SELECTORS.SCROLL_CONTAINER) || window;

            this.scrollHandler = throttle(() => {
                this.tocPanel.updateActiveByScroll();
            }, CONFIG.THROTTLE_DELAY);

            if (scrollContainer === window) {
                window.addEventListener('scroll', this.scrollHandler, { passive: true });
            } else {
                scrollContainer.addEventListener('scroll', this.scrollHandler, { passive: true });
            }
        }

        /**
         * 销毁
         */
        destroy() {
            if (this.observer) {
                this.observer.disconnect();
            }
            if (this.scrollHandler) {
                window.removeEventListener('scroll', this.scrollHandler);
            }
        }
    }

    // ============================================================
    // 启动
    // ============================================================
    const app = new ChatGPTChatNavigator();
    app.init();
})();
