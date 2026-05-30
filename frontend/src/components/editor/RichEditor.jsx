import { useEditor, EditorContent, Extension } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

// Matches {{anything inside}} including spaces, underscores, hyphens
const VAR_REGEX = /\{\{[^}]+\}\}/g;

const VariableHighlight = Extension.create({
  name: 'variableHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('variableHighlight'),
        state: {
          init(_, state) {
            return buildDecorations(state.doc);
          },
          apply(tr, old) {
            return tr.docChanged ? buildDecorations(tr.doc) : old;
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});

function buildDecorations(doc) {
  const decorations = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    let match;
    VAR_REGEX.lastIndex = 0;
    while ((match = VAR_REGEX.exec(node.text)) !== null) {
      decorations.push(
        Decoration.inline(pos + match.index, pos + match.index + match[0].length, {
          style: 'background:rgba(108,99,255,0.18);color:#6c63ff;border-radius:4px;padding:1px 3px;font-weight:600;',
        })
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

export default function RichEditor({ value, onChange, variables = [], placeholder }) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      VariableHighlight,
    ],
    content: value || '',
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
  });

  if (!editor) return null;

  const insertVariable = (varName) => {
    editor.chain().focus().insertContent(`{{${varName}}}`).run();
  };

  const setLink = () => {
    const url = window.prompt('URL:');
    if (url) editor.chain().focus().setLink({ href: url }).run();
  };

  return (
    <div className="editor-wrapper">
      <div className="editor-toolbar">
        <button type="button" className={`editor-toolbar-btn ${editor.isActive('bold') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold"><b>B</b></button>
        <button type="button" className={`editor-toolbar-btn ${editor.isActive('italic') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic"><i>I</i></button>
        <button type="button" className={`editor-toolbar-btn ${editor.isActive('underline') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline"><u>U</u></button>
        <div className="editor-toolbar-divider" />
        <button type="button" className={`editor-toolbar-btn ${editor.isActive('bulletList') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet List">≡</button>
        <button type="button" className={`editor-toolbar-btn ${editor.isActive('orderedList') ? 'active' : ''}`} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered List">1.</button>
        <div className="editor-toolbar-divider" />
        <button type="button" className={`editor-toolbar-btn ${editor.isActive('link') ? 'active' : ''}`} onClick={setLink} title="Link">🔗</button>
        <button type="button" className="editor-toolbar-btn" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()} title="Clear formatting">✕</button>

        {variables.length > 0 && (
          <>
            <div className="editor-toolbar-divider" />
            <span style={{ fontSize: '11px', color: 'var(--text3)', alignSelf: 'center', marginRight: 4 }}>Variables:</span>
            {variables.map(v => (
              <button key={v} type="button" className="editor-toolbar-var-btn" onClick={() => insertVariable(v)} title={`Insert {{${v}}}`}>
                {`{{${v}}}`}
              </button>
            ))}
          </>
        )}
      </div>
      <EditorContent editor={editor} />
      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>
        💡 <span style={{ color: '#6c63ff', fontWeight: 600 }}>Purple highlights</span> show variables — recipients see normal text
      </div>
    </div>
  );
}
