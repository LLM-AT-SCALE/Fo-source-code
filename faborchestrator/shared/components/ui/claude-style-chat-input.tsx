"use client"

import React, { useState, useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";
import { Plus, ChevronDown, ChevronRight, ArrowUp, ArrowRight, X, FileText, Loader2, Check, Archive, Globe, Paperclip, LayoutGrid, Square, ShieldCheck } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/components/ui/tooltip";
import { formatFileSize } from "@/shared/lib/file-utils";

/* --- ICONS --- */
export const Icons = {
    Logo: (props: React.SVGProps<SVGSVGElement>) => (
        <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" role="presentation" {...props}>
            <defs>
                <ellipse id="petal-pair" cx="100" cy="100" rx="90" ry="22" />
            </defs>
            <g fill="var(--brand-logo)" fillRule="evenodd">
                <use href="#petal-pair" transform="rotate(0 100 100)" />
                <use href="#petal-pair" transform="rotate(45 100 100)" />
                <use href="#petal-pair" transform="rotate(90 100 100)" />
                <use href="#petal-pair" transform="rotate(135 100 100)" />
            </g>
        </svg>
    ),
    Plus: Plus,
    Thinking: (props: React.SVGProps<SVGSVGElement>) => <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" {...props}><path d="M10.3857 2.50977C14.3486 2.71054 17.5 5.98724 17.5 10C17.5 14.1421 14.1421 17.5 10 17.5C5.85786 17.5 2.5 14.1421 2.5 10C2.5 9.72386 2.72386 9.5 3 9.5C3.27614 9.5 3.5 9.72386 3.5 10C3.5 13.5899 6.41015 16.5 10 16.5C13.5899 16.5 16.5 13.5899 16.5 10C16.5 6.5225 13.7691 3.68312 10.335 3.50879L10 3.5L9.89941 3.49023C9.67145 3.44371 9.5 3.24171 9.5 3C9.5 2.72386 9.72386 2.5 10 2.5L10.3857 2.50977ZM10 5.5C10.2761 5.5 10.5 5.72386 10.5 6V9.69043L13.2236 11.0527C13.4706 11.1762 13.5708 11.4766 13.4473 11.7236C13.3392 11.9397 13.0957 12.0435 12.8711 11.9834L12.7764 11.9473L9.77637 10.4473C9.60698 10.3626 9.5 10.1894 9.5 10V6C9.5 5.72386 9.72386 5.5 10 5.5ZM3.66211 6.94141C4.0273 6.94159 4.32303 7.23735 4.32324 7.60254C4.32324 7.96791 4.02743 8.26446 3.66211 8.26465C3.29663 8.26465 3 7.96802 3 7.60254C3.00021 7.23723 3.29676 6.94141 3.66211 6.94141ZM4.95605 4.29395C5.32146 4.29404 5.61719 4.59063 5.61719 4.95605C5.6171 5.3214 5.3214 5.61709 4.95605 5.61719C4.59063 5.61719 4.29403 5.32146 4.29395 4.95605C4.29395 4.59057 4.59057 4.29395 4.95605 4.29395ZM7.60254 3C7.96802 3 8.26465 3.29663 8.26465 3.66211C8.26446 4.02743 7.96791 4.32324 7.60254 4.32324C7.23736 4.32302 6.94159 4.0273 6.94141 3.66211C6.94141 3.29676 7.23724 3.00022 7.60254 3Z"></path></svg>,
    SelectArrow: ChevronDown,
    ArrowUp: ArrowUp,
    ArrowRight: ArrowRight,
    X: X,
    FileText: FileText,
    Loader2: Loader2,
    Check: Check,
    Archive: Archive,
    Square: Square,
    Clock: (props: React.SVGProps<SVGSVGElement>) => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="currentColor" {...props}><path d="M10.3857 2.50977C14.3486 2.71054 17.5 5.98724 17.5 10C17.5 14.1421 14.1421 17.5 10 17.5C5.85786 17.5 2.5 14.1421 2.5 10C2.5 9.72386 2.72386 9.5 3 9.5C3.27614 9.5 3.5 9.72386 3.5 10C3.5 13.5899 6.41015 16.5 10 16.5C13.5899 16.5 16.5 13.5899 16.5 10C16.5 6.5225 13.7691 3.68312 10.335 3.50879L10 3.5L9.89941 3.49023C9.67145 3.44371 9.5 3.24171 9.5 3C9.5 2.72386 9.72386 2.5 10 2.5L10.3857 2.50977ZM10 5.5C10.2761 5.5 10.5 5.72386 10.5 6V9.69043L13.2236 11.0527C13.4706 11.1762 13.5708 11.4766 13.4473 11.7236C13.3392 11.9397 13.0957 12.0435 12.8711 11.9834L12.7764 11.9473L9.77637 10.4473C9.60698 10.3626 9.5 10.1894 9.5 10V6C9.5 5.72386 9.72386 5.5 10 5.5ZM3.66211 6.94141C4.0273 6.94159 4.32303 7.23735 4.32324 7.60254C4.32324 7.96791 4.02743 8.26446 3.66211 8.26465C3.29663 8.26465 3 7.96802 3 7.60254C3.00021 7.23723 3.29676 6.94141 3.66211 6.94141ZM4.95605 4.29395C5.32146 4.29404 5.61719 4.59063 5.61719 4.95605C5.6171 5.3214 5.3214 5.61709 4.95605 5.61719C4.59063 5.61719 4.29403 5.32146 4.29395 4.95605C4.29395 4.59057 4.59057 4.29395 4.95605 4.29395ZM7.60254 3C7.96802 3 8.26465 3.29663 8.26465 3.66211C8.26446 4.02743 7.96791 4.32324 7.60254 4.32324C7.23736 4.32302 6.94159 4.0273 6.94141 3.66211C6.94141 3.29676 7.23724 3.00022 7.60254 3Z"></path></svg>,
    VoiceWave: (props: React.SVGProps<SVGSVGElement>) => (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...props}>
            <line x1="4" y1="8" x2="4" y2="16" />
            <line x1="7.5" y1="5" x2="7.5" y2="19" />
            <line x1="11" y1="7" x2="11" y2="17" />
            <line x1="14.5" y1="4" x2="14.5" y2="20" />
            <line x1="18" y1="6" x2="18" y2="18" />
            <line x1="21" y1="9" x2="21" y2="15" />
        </svg>
    ),
};

/* --- COMPONENTS --- */

// 1. File Preview Card
interface AttachedFile {
    id: string;
    file: File;
    type: string;
    preview: string | null;
    uploadStatus: string;
    content?: string;
}

interface FilePreviewCardProps {
    file: AttachedFile;
    onRemove: (id: string) => void;
}

const FilePreviewCard: React.FC<FilePreviewCardProps> = ({ file, onRemove }) => {
    const isImage = file.type.startsWith("image/") && file.preview;

    return (
        <div className={`relative group flex-shrink-0 w-24 h-24 rounded-xl overflow-hidden border border-bg-300 bg-bg-200 animate-fade-in transition-colors hover:border-text-400`}>
            {isImage ? (
                <div className="w-full h-full relative">
                    {/* Local blob-preview thumbnail (no known dimensions / loader) — plain img. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={file.preview!} alt={file.file.name} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-black/20 group-hover:bg-black/0 transition-colors" />
                </div>
            ) : (
                <div className="w-full h-full p-3 flex flex-col justify-between">
                    <div className="flex items-center gap-2">
                        <div className="p-1.5 bg-bg-300 rounded">
                            <Icons.FileText className="w-4 h-4 text-text-300" />
                        </div>
                        <span className="text-[10px] font-medium text-text-400 uppercase tracking-wider truncate">
                            {file.file.name.split('.').pop()}
                        </span>
                    </div>
                    <div className="space-y-0.5">
                        <p className="text-xs font-medium text-text-200 truncate" title={file.file.name}>
                            {file.file.name}
                        </p>
                        <p className="text-[10px] text-text-500">
                            {formatFileSize(file.file.size)}
                        </p>
                    </div>
                </div>
            )}

            {/* Remove Button Overlay */}
            <button
                onClick={() => onRemove(file.id)}
                className="absolute top-1 right-1 p-1 bg-black/50 hover:bg-black/70 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity"
                type="button"
                aria-label={`Remove ${file.file.name}`}
            >
                <Icons.X aria-hidden="true" className="w-3 h-3" />
            </button>

            {/* Upload Status */}
            {file.uploadStatus === 'uploading' && (
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    <Icons.Loader2 className="w-5 h-5 text-white animate-spin" />
                </div>
            )}
        </div>
    );
};

// 2. Pasted Content Card
interface PastedContentCardProps {
    content: {
        id: string;
        content: string;
        timestamp: Date;
    };
    onRemove: (id: string) => void;
}

const PastedContentCard: React.FC<PastedContentCardProps> = ({ content, onRemove }) => {
    return (
        <div className="relative group flex-shrink-0 w-28 h-28 rounded-2xl overflow-hidden border border-bg-300 dark:border-bg-200 bg-white dark:bg-bg-0 animate-fade-in p-3 flex flex-col justify-between shadow-sm">
            <div className="overflow-hidden w-full">
                <p className="text-[10px] text-text-400 leading-[1.4] font-mono break-words whitespace-pre-wrap line-clamp-4 select-none">
                    {content.content}
                </p>
            </div>

            <div className="flex items-center justify-between w-full mt-2">
                <div className="inline-flex items-center justify-center px-1.5 py-[2px] rounded border border-bg-300 dark:border-bg-300 bg-white dark:bg-transparent">
                    <span className="text-[9px] font-bold text-text-300 dark:text-text-400 uppercase tracking-wider font-sans">PASTED</span>
                </div>
            </div>

            <button
                onClick={() => onRemove(content.id)}
                className="absolute top-2 right-2 p-[3px] bg-white dark:bg-bg-200 border border-bg-300 dark:border-bg-300 rounded-full text-text-400 hover:text-text-300 dark:hover:text-white transition-colors shadow-sm opacity-0 group-hover:opacity-100"
                type="button"
                aria-label="Remove pasted content"
            >
                <Icons.X aria-hidden="true" className="w-2 h-2" />
            </button>
        </div>
    );
};

// 3. Model Selector
interface Model {
    id: string;
    name: string;
    description: string;
    badge?: string;
    disabled?: boolean;
}

interface ModelSelectorProps {
    models: Model[];
    selectedModel: string;
    onSelect: (modelId: string) => void;
}

// Latest model IDs shown in main menu
const LATEST_MODEL_IDS = new Set(['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-fable-5-1']);

const ModelSelector: React.FC<ModelSelectorProps> = ({ models, selectedModel, onSelect }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [isSubmenuOpen, setIsSubmenuOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const currentModel = models.find(m => m.id === selectedModel) || models[0];
    const latestModels = models.filter(m => LATEST_MODEL_IDS.has(m.id));
    const olderModels = models.filter(m => !LATEST_MODEL_IDS.has(m.id));

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
                setIsSubmenuOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const renderModelItem = (model: Model) => (
        <button
            key={model.id}
            onClick={() => {
                if (model.disabled) return;
                onSelect(model.id);
                setIsOpen(false);
                setIsSubmenuOpen(false);
            }}
            className={`w-full text-left px-3 py-2 rounded-xl flex items-start justify-between group transition-colors ${
                model.disabled
                    ? 'opacity-40 cursor-not-allowed'
                    : 'hover:bg-bg-200 dark:hover:bg-bg-200 cursor-pointer'
            }`}
            type="button"
            disabled={model.disabled}
        >
            <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                    <span className={`text-[13px] font-semibold ${model.disabled ? 'text-text-300' : 'text-text-100 dark:text-text-100'}`}>
                        {model.name}
                    </span>
                    {model.disabled && (
                        <span className="px-1.5 py-[1px] rounded-full text-[10px] font-medium border border-bg-300 text-text-400">
                            Coming soon
                        </span>
                    )}
                    {model.badge && !model.disabled && (
                        <span className={`px-1.5 py-[1px] rounded-full text-[10px] font-medium border ${model.badge === 'Upgrade'
                            ? 'border-blue-200 text-blue-600 bg-white dark:border-blue-500/30 dark:text-blue-400 dark:bg-blue-500/10'
                            : 'border-bg-300 text-text-300'
                            }`}>
                            {model.badge}
                        </span>
                    )}
                </div>
                <span className="text-[11px] text-text-300 dark:text-text-500">
                    {model.description}
                </span>
            </div>
            {selectedModel === model.id && !model.disabled && (
                <Icons.Check className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-1" />
            )}
        </button>
    );

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={`inline-flex items-center justify-center relative shrink-0 transition font-base duration-300 ease-[cubic-bezier(0.165,0.85,0.45,1)] h-8 rounded-xl px-3 min-w-[4rem] active:scale-[0.98] whitespace-nowrap !text-xs pl-2.5 pr-2 gap-1 cursor-pointer
                ${isOpen
                        ? 'bg-bg-200 text-text-100 dark:bg-bg-300 dark:text-text-100'
                        : 'text-text-300 hover:text-text-200 hover:bg-bg-200 dark:text-text-300 dark:hover:text-text-100 dark:hover:bg-bg-300'}`}
                type="button"
            >
                <div className="font-ui inline-flex gap-[3px] text-[14px] h-[14px] leading-none items-baseline">
                    <div className="flex items-center gap-[4px]">
                        <div className="whitespace-nowrap select-none font-medium">{currentModel.name}</div>
                    </div>
                </div>
                <div className="flex items-center justify-center opacity-75" style={{ width: '20px', height: '20px' }}>
                    <Icons.SelectArrow className={`shrink-0 opacity-75 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
                </div>
            </button>

            {isOpen && (
                <div className="absolute bottom-full right-0 mb-2 w-[260px] bg-white dark:bg-bg-0 border border-bg-300 dark:border-bg-200 rounded-2xl shadow-2xl z-50 flex flex-col p-1.5 animate-fade-in origin-bottom-right">
                    {/* Latest models */}
                    {latestModels.map(renderModelItem)}

                    {/* More models - flyout submenu */}
                    {olderModels.length > 0 && (
                        <>
                            <div className="my-1 mx-2 border-t border-border dark:border-bg-200" />
                            <div
                                className="relative"
                                onMouseEnter={() => setIsSubmenuOpen(true)}
                                onMouseLeave={() => setIsSubmenuOpen(false)}
                            >
                                <button
                                    onClick={() => setIsSubmenuOpen(!isSubmenuOpen)}
                                    className={`flex items-center gap-3 px-3 py-2 mx-0 rounded-xl transition-colors w-full cursor-pointer ${isSubmenuOpen ? 'bg-bg-200 dark:bg-bg-200' : 'hover:bg-bg-200 dark:hover:bg-bg-200'}`}
                                    type="button"
                                >
                                    <span className="text-[13px] font-medium flex-1 text-left text-text-300 dark:text-text-500">More models</span>
                                    <ChevronRight className="w-3.5 h-3.5 text-text-400 dark:text-text-400" />
                                </button>

                                {/* Flyout submenu - positioned to the left */}
                                {isSubmenuOpen && (
                                    <div className="absolute left-full top-0 ml-1 w-[260px] bg-white dark:bg-bg-0 border border-bg-300 dark:border-bg-200 rounded-2xl shadow-2xl z-50 flex flex-col p-1.5 animate-fade-in">
                                        {olderModels.map(renderModelItem)}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};

// 4. Main Chat Input Component
export interface ClaudeChatInputHandle {
    setMessage: (text: string) => void;
    focus: () => void;
}

interface McpConnectionsSubmenuProps {
    activeMcpIds: string[];
    onToggle: (connectionId: string, isActive: boolean) => void;
    onManageConnectors?: () => void;
    /** Conversation agent whose connections the submenu lists. */
    agent?: string;
}

interface ClaudeChatInputProps {
    onSendMessage: (data: {
        message: string;
        files: AttachedFile[];
        pastedContent: AttachedFile[];
        model: string;
        isThinkingEnabled: boolean;
    }) => void;
    models?: Model[];
    defaultModel?: string;
    placeholder?: string;
    webSearchEnabled?: boolean;
    onWebSearchChange?: (enabled: boolean) => void;
    activeMcpIds?: string[];
    /** false hides the Connectors entry entirely (role without MCP permission). */
    mcpEnabled?: boolean;
    onMcpToggle?: (connectionId: string, isActive: boolean) => void;
    McpConnectionsSubmenu?: React.ComponentType<McpConnectionsSubmenuProps>;
    /** Passed through to the submenu: which agent's connections to list. */
    mcpAgent?: string;
    onManageConnectors?: () => void;
    /** Admin chat: route a credentials file to the data-source flow instead of the chat. */
    onSecureUpload?: (file: File) => void;
    isLoading?: boolean;
    onStop?: () => void;
    isThinkingEnabled?: boolean;
    onThinkingChange?: (enabled: boolean) => void;
}

export const ClaudeChatInput = forwardRef<ClaudeChatInputHandle, ClaudeChatInputProps>(
    ({ onSendMessage, models: modelsProp, defaultModel, placeholder = "How can I help you today?", webSearchEnabled, onWebSearchChange, activeMcpIds, onMcpToggle, McpConnectionsSubmenu, mcpAgent, onManageConnectors, onSecureUpload, mcpEnabled = true, isLoading, onStop, isThinkingEnabled: isThinkingEnabledProp, onThinkingChange }, ref) => {
    const [message, setMessage] = useState("");
    const [files, setFiles] = useState<AttachedFile[]>([]);
    const [pastedContent, setPastedContent] = useState<{ id: string; content: string; timestamp: Date }[]>([]);
    const [isDragging, setIsDragging] = useState(false);
    const [isThinkingEnabledInternal, setIsThinkingEnabledInternal] = useState(false);
    const isThinkingEnabled = isThinkingEnabledProp !== undefined ? isThinkingEnabledProp : isThinkingEnabledInternal;
    const setIsThinkingEnabled = onThinkingChange ?? setIsThinkingEnabledInternal;
    const [isPlusMenuOpen, setIsPlusMenuOpen] = useState(false);
    const [isMcpSubmenuOpen, setIsMcpSubmenuOpen] = useState(false);

    const defaultModels: Model[] = [
        { id: "claude-sonnet-5", name: "FabOrchestrator 1", description: "Fast and efficient for everyday work" },
        { id: "claude-opus-5", name: "FabOrchestrator 2", description: "Strong reasoning for complex tasks" },
        { id: "claude-fable-5", name: "FabOrchestrator 3", description: "Advanced reasoning for demanding work" },
        { id: "claude-fable-5-1", name: "FabOrchestrator 4", description: "Most capable model" },
    ];

    const models = modelsProp || defaultModels;
    const [selectedModel, setSelectedModel] = useState(defaultModel || models[0]?.id || "");

    // Sync defaultModel prop
    useEffect(() => {
        if (defaultModel) setSelectedModel(defaultModel);
    }, [defaultModel]);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const secureFileInputRef = useRef<HTMLInputElement>(null);
    const plusMenuRef = useRef<HTMLDivElement>(null);

    // Expose imperative handle for parent to set message
    useImperativeHandle(ref, () => ({
        setMessage: (text: string) => {
            setMessage(text);
            textareaRef.current?.focus();
        },
        focus: () => {
            textareaRef.current?.focus();
        },
    }));

    // Auto-resize textarea
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
            textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 384) + "px";
        }
    }, [message]);

    // Click-outside handler for plus menu
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (plusMenuRef.current && !plusMenuRef.current.contains(event.target as Node)) {
                setIsPlusMenuOpen(false);
                setIsMcpSubmenuOpen(false);
            }
        };
        if (isPlusMenuOpen) {
            document.addEventListener("mousedown", handleClickOutside);
            return () => document.removeEventListener("mousedown", handleClickOutside);
        }
    }, [isPlusMenuOpen]);

    // Reset MCP submenu when plus menu closes
    useEffect(() => {
        if (!isPlusMenuOpen) setIsMcpSubmenuOpen(false);
    }, [isPlusMenuOpen]);

    // File Handling
    const handleFiles = useCallback((newFilesList: FileList | File[]) => {
        const newFiles = Array.from(newFilesList).map(file => {
            const isImage = file.type.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(file.name);
            return {
                id: Math.random().toString(36).substr(2, 9),
                file,
                type: isImage ? 'image/unknown' : (file.type || 'application/octet-stream'),
                preview: isImage ? URL.createObjectURL(file) : null,
                uploadStatus: 'pending'
            };
        });

        setFiles(prev => [...prev, ...newFiles]);

        // Don't auto-fill message text when files are attached — let user type their own prompt

        newFiles.forEach(f => {
            setTimeout(() => {
                setFiles(prev => prev.map(p => p.id === f.id ? { ...p, uploadStatus: 'complete' } : p));
            }, 800 + Math.random() * 1000);
        });
    }, []);

    // Drag & Drop
    const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
    const onDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
    const onDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    };

    // Paste Handling
    const handlePaste = (e: React.ClipboardEvent) => {
        const items = e.clipboardData.items;
        const pastedFiles: File[] = [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].kind === 'file') {
                const file = items[i].getAsFile();
                if (file) pastedFiles.push(file);
            }
        }

        if (pastedFiles.length > 0) {
            e.preventDefault();
            handleFiles(pastedFiles);
            return;
        }

        const text = e.clipboardData.getData('text');
        if (text.length > 300) {
            e.preventDefault();
            const snippet = {
                id: Math.random().toString(36).substr(2, 9),
                content: text,
                timestamp: new Date()
            };
            setPastedContent(prev => [...prev, snippet]);
        }
    };

    const handleSend = () => {
        if (isLoading) return;
        if (!message.trim() && files.length === 0 && pastedContent.length === 0) return;
        const pastedAsFiles: AttachedFile[] = pastedContent.map(p => ({
            id: p.id,
            file: new File([p.content], 'pasted-text.txt', { type: 'text/plain' }),
            type: 'text/plain',
            preview: null,
            uploadStatus: 'complete',
            content: p.content,
        }));
        onSendMessage({ message, files, pastedContent: pastedAsFiles, model: selectedModel, isThinkingEnabled });
        setMessage("");
        setFiles([]);
        setPastedContent([]);
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape' && isLoading && onStop) {
            onStop();
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (isLoading) return;
            handleSend();
        }
    };

    const hasContent = message.trim() || files.length > 0 || pastedContent.length > 0;

    return (
        <TooltipProvider delayDuration={300}>
        <div
            className={`relative w-full transition-[width] duration-300 font-sans`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            {/* Main Container */}
            <div className={`
                !box-content flex flex-col items-stretch transition-colors duration-200 relative z-10 rounded-2xl cursor-text border border-bg-300 dark:border-transparent
                shadow-lg hover:shadow-xl
                focus-within:shadow-xl
                bg-white dark:bg-bg-200 font-sans antialiased
            `}>

                <div className="flex flex-col px-3 pt-3 pb-2 gap-2">

                    {/* 1. Artifacts (Files & Pastes) */}
                    {(files.length > 0 || pastedContent.length > 0) && (
                        <div className="flex flex-wrap gap-3 overflow-x-auto pb-2 px-1">
                            {pastedContent.map(content => (
                                <PastedContentCard
                                    key={content.id}
                                    content={content}
                                    onRemove={id => setPastedContent(prev => prev.filter(c => c.id !== id))}
                                />
                            ))}
                            {files.map(file => (
                                <FilePreviewCard
                                    key={file.id}
                                    file={file}
                                    onRemove={id => setFiles(prev => prev.filter(f => f.id !== id))}
                                />
                            ))}
                        </div>
                    )}

                    {/* 2. Input Area */}
                    <div className="relative mb-1">
                        <div className="max-h-96 w-full overflow-y-auto font-sans break-words transition-opacity duration-200 min-h-[2.5rem] pl-1">
                            <textarea
                                ref={textareaRef}
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                onPaste={handlePaste}
                                onKeyDown={handleKeyDown}
                                placeholder={placeholder}
                                className="w-full bg-transparent border-0 outline-none text-text-100 text-[16px] placeholder:text-text-400 resize-none overflow-hidden py-0 leading-relaxed block font-normal antialiased"
                                rows={1}
                                autoFocus
                                style={{ minHeight: '1.5em' }}
                            />
                        </div>
                    </div>

                    {/* 3. Action Bar */}
                    <div className="flex gap-2 w-full items-center">
                        {/* Left Tools */}
                        <div className="relative flex-1 flex items-center shrink min-w-0 gap-1">
                            {/* Plus Menu Button + Dropdown */}
                            <div className="relative" ref={plusMenuRef}>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={() => setIsPlusMenuOpen(!isPlusMenuOpen)}
                                            className={`inline-flex items-center justify-center relative shrink-0 transition-colors duration-200 h-8 w-8 rounded-lg active:scale-95 cursor-pointer
                                                ${isPlusMenuOpen
                                                    ? 'bg-bg-200 text-text-200'
                                                    : 'text-text-400 hover:text-text-200 hover:bg-bg-200'}`}
                                            type="button"
                                            aria-label="More options"
                                            aria-expanded={isPlusMenuOpen}
                                        >
                                            <Icons.Plus aria-hidden="true" className={`w-5 h-5 transition-transform duration-200 ${isPlusMenuOpen ? 'rotate-45' : ''}`} />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">Add files, connectors & more</TooltipContent>
                                </Tooltip>

                                {isPlusMenuOpen && (
                                    <div className="absolute bottom-full left-0 mb-2 w-[220px] bg-white dark:bg-popover border border-border dark:border-sidebar-border rounded-xl shadow-xl z-50 flex flex-col py-1 animate-fade-in origin-bottom-left">
                                        {/* Add files or photos */}
                                        <button
                                            onClick={() => {
                                                fileInputRef.current?.click();
                                                setIsPlusMenuOpen(false);
                                            }}
                                            className="flex items-center gap-3 px-3 py-2 mx-1 rounded-lg transition-colors hover:bg-bg-hover dark:hover:bg-bg-hover"
                                            type="button"
                                        >
                                            <Paperclip className="w-[18px] h-[18px] text-text-300 dark:text-text-500" />
                                            <span className="text-[14px] text-text-200 dark:text-foreground">Add files or photos</span>
                                        </button>

                                        {/* Secure Upload — for database connection credentials only (admin chat) */}
                                        {onSecureUpload && (
                                            <>
                                                <div className="mx-3 my-1 border-t border-border/70 dark:border-sidebar-border/70" />
                                                <button
                                                    onClick={() => {
                                                        secureFileInputRef.current?.click();
                                                        setIsPlusMenuOpen(false);
                                                    }}
                                                    className="flex items-center gap-3 px-3 py-2 mx-1 rounded-lg transition-colors hover:bg-bg-hover dark:hover:bg-bg-hover"
                                                    type="button"
                                                >
                                                    <ShieldCheck className="w-[18px] h-[18px] text-blue-600" />
                                                    <span className="text-[14px] text-left text-text-200 dark:text-foreground">Secure Upload<span className="block text-[11px] text-text-400">Add a data source&apos;s login details</span></span>
                                                </button>
                                            </>
                                        )}

                                        {/* Separator */}
                                        <div className="my-1 border-t border-border dark:border-sidebar-border" />

                                        {/* Web search */}
                                        {onWebSearchChange && (
                                            <button
                                                onClick={() => onWebSearchChange(!webSearchEnabled)}
                                                className="flex items-center gap-3 px-3 py-2 mx-1 rounded-lg transition-colors hover:bg-bg-hover dark:hover:bg-bg-hover"
                                                type="button"
                                            >
                                                <Globe className={`w-[18px] h-[18px] ${webSearchEnabled ? 'text-accent' : 'text-text-300 dark:text-text-500'}`} />
                                                <span className={`text-[14px] flex-1 text-left ${webSearchEnabled ? 'text-accent font-medium' : 'text-text-200 dark:text-foreground'}`}>
                                                    Web search
                                                </span>
                                                {webSearchEnabled && (
                                                    <Check className="w-4 h-4 text-accent" />
                                                )}
                                            </button>
                                        )}

                                        {/* Connectors - flyout submenu */}
                                        {McpConnectionsSubmenu && onMcpToggle && mcpEnabled && (
                                            <div
                                                className="relative"
                                                onMouseEnter={() => setIsMcpSubmenuOpen(true)}
                                                onMouseLeave={() => setIsMcpSubmenuOpen(false)}
                                            >
                                                <button
                                                    onClick={() => setIsMcpSubmenuOpen(!isMcpSubmenuOpen)}
                                                    className={`flex items-center gap-3 px-3 py-2 mx-1 rounded-lg transition-colors w-[calc(100%-8px)] ${isMcpSubmenuOpen ? 'bg-bg-hover dark:bg-bg-hover' : 'hover:bg-bg-hover dark:hover:bg-bg-hover'}`}
                                                    type="button"
                                                >
                                                    <LayoutGrid className="w-[18px] h-[18px] text-text-300 dark:text-text-500" />
                                                    <span className="text-[14px] flex-1 text-left text-text-200 dark:text-foreground">Connectors</span>
                                                    <ChevronRight className="w-4 h-4 text-text-500" />
                                                </button>

                                                {/* Flyout submenu - positioned to the right */}
                                                {isMcpSubmenuOpen && (
                                                    <div className="absolute left-full top-0 ml-1 w-[260px] bg-white dark:bg-popover border border-border dark:border-sidebar-border rounded-xl shadow-xl z-50 py-1 animate-fade-in">
                                                        <div className="max-h-[300px] overflow-y-auto">
                                                            <McpConnectionsSubmenu
                                                                agent={mcpAgent}
                                                                activeMcpIds={activeMcpIds || []}
                                                                onToggle={onMcpToggle}
                                                                onManageConnectors={onManageConnectors}
                                                            />
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Extended Thinking Button */}
                            <div className="flex shrink min-w-8 !shrink-0">
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={() => setIsThinkingEnabled(!isThinkingEnabled)}
                                            className={`transition-[transform,opacity] duration-200 h-8 w-8 flex items-center justify-center rounded-lg active:scale-95 cursor-pointer
                                                ${isThinkingEnabled
                                                    ? 'text-accent bg-accent/10'
                                                    : 'text-text-400 hover:text-text-200 hover:bg-bg-200'}
                                            `}
                                            aria-pressed={isThinkingEnabled}
                                            aria-label="Extended thinking"
                                            type="button"
                                        >
                                            <Icons.Thinking aria-hidden="true" className="w-5 h-5" />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">Extended thinking</TooltipContent>
                                </Tooltip>
                            </div>
                        </div>

                        {/* Right Tools */}
                        <div className="flex flex-row items-center min-w-0 gap-1">
                            {/* Model Selector */}
                            <div className="shrink-0 p-1 -m-1">
                                <ModelSelector
                                    models={models}
                                    selectedModel={selectedModel}
                                    onSelect={(id) => {
                                        const m = models.find(x => x.id === id);
                                        if (m?.disabled) return;
                                        setSelectedModel(id);
                                    }}
                                />
                            </div>

                            {/* Send / Stop / Voice Button */}
                            <div>
                                {isLoading ? (
                                    <button
                                        onClick={onStop}
                                        className="inline-flex items-center justify-center relative shrink-0 transition-[transform,opacity] duration-200 h-8 w-8 rounded-xl active:scale-95 bg-text-100 dark:bg-text-100 text-bg-0 dark:text-bg-0 hover:opacity-90"
                                        type="button"
                                        aria-label="Stop generation"
                                    >
                                        <Icons.Square aria-hidden="true" className="w-3 h-3" />
                                    </button>
                                ) : hasContent ? (
                                    <button
                                        onClick={handleSend}
                                        className="inline-flex items-center justify-center relative shrink-0 transition-[transform,opacity,background-color] duration-200 h-8 w-8 rounded-xl active:scale-95 bg-primary text-primary-foreground hover:bg-primary/90 shadow-md"
                                        type="button"
                                        aria-label="Send message"
                                    >
                                        <Icons.ArrowRight aria-hidden="true" className="w-4 h-4" />
                                    </button>
                                ) : (
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                className="inline-flex items-center justify-center relative shrink-0 transition-[transform,opacity] duration-200 h-8 w-8 rounded-xl active:scale-95 cursor-pointer bg-bg-200 dark:bg-sidebar-border text-text-300 hover:text-text-200 hover:bg-bg-300 dark:hover:bg-bg-300"
                                                type="button"
                                                aria-label="Voice input"
                                            >
                                                <Icons.VoiceWave aria-hidden="true" className="w-[18px] h-[18px]" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent side="top">Use voice mode</TooltipContent>
                                    </Tooltip>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Drag Overlay */}
            {isDragging && (
                <div className="absolute inset-0 bg-bg-200/90 border-2 border-dashed border-accent rounded-2xl z-50 flex flex-col items-center justify-center backdrop-blur-sm pointer-events-none">
                    <Icons.Archive className="w-10 h-10 text-accent mb-2 animate-bounce" />
                    <p className="text-accent font-medium">Drop files to upload</p>
                </div>
            )}

            {/* Hidden File Input */}
            <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                    if (e.target.files) handleFiles(e.target.files);
                    e.target.value = '';
                }}
            />

            {/* Hidden Secure-Upload Input — routes the file to onSecureUpload, NOT the chat */}
            {onSecureUpload && (
                <input
                    ref={secureFileInputRef}
                    type="file"
                    accept=".json,.txt,.env,.md,.yaml,.yml,.cfg,.conf,.csv,.docx,.xlsx,text/plain,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className="hidden"
                    onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) onSecureUpload(f);
                        e.target.value = '';
                    }}
                />
            )}
        </div>
        </TooltipProvider>
    );
});

ClaudeChatInput.displayName = "ClaudeChatInput";

export default ClaudeChatInput;
export type { AttachedFile, Model };
