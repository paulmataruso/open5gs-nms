import { useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';

interface Props {
  value: string;
  onChange: (value: string) => void;
  serviceName: string;
}

export function YamlTextEditor({ value, onChange, serviceName }: Props): JSX.Element {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  function handleEditorDidMount(editor: Monaco.editor.IStandaloneCodeEditor) {
    editorRef.current = editor;
  }

  function handleEditorChange(value: string | undefined) {
    if (value !== undefined) {
      onChange(value);
    }
  }

  useEffect(() => {
    // Reset scroll position when service changes
    if (editorRef.current) {
      editorRef.current.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
    }
  }, [serviceName]);

  return (
    <div className="h-full">
      <Editor
        height="600px"
        defaultLanguage="yaml"
        value={value}
        onChange={handleEditorChange}
        onMount={handleEditorDidMount}
        theme="vs-dark"
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: 'on',
          rulers: [80, 120],
          scrollBeyondLastLine: false,
          wordWrap: 'off',
          tabSize: 2,
          insertSpaces: true,
          automaticLayout: true,
        }}
      />
    </div>
  );
}
