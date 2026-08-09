import React from 'react';
import { EditableTextBlockProps } from '@/types';
import { useEditableTextBlock } from '@/hooks';

// ============================================
// Main Component
// ============================================
// Generic inline-editable text element (used for titles, notes, list items,
// etc. across the app). All editing state, debounced saving, and keyboard
// handling now live in useEditableTextBlock — this component only renders.
const EditableTextBlock: React.FC<EditableTextBlockProps> = ({
    initialValue,
    onSave,
    tagName = 'div',
    className = '',
    placeholder = 'Type here...',
    multiline = true,
    onEnter,
    autoFocus = false
}) => {
    const { isEditing, localValue, contentRef, handleChange, handleBlur, handleClick, handleKeyDown } =
        useEditableTextBlock({ initialValue, onSave, multiline, autoFocus, onEnter });

    const Tag = tagName as any;

    return (
        <Tag
            ref={contentRef}
            contentEditable={isEditing}
            suppressContentEditableWarning={true}
            onClick={handleClick}
            onBlur={handleBlur}
            onInput={handleChange}
            onKeyDown={handleKeyDown}
            className={`
                outline-none min-w-[10px] cursor-text transition-colors duration-200
                bg-transparent
                ${!localValue && placeholder ? 'empty:before:content-[attr(data-placeholder)] empty:before:text-white/20' : ''}
                ${className}
            `}
            data-placeholder={placeholder}
            spellCheck={false} // Clean look
        >
            {initialValue}
        </Tag>
    );
};

export default EditableTextBlock;