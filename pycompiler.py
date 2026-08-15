#!/usr/bin/env python3
"""
Python PyCompiler - Compile .py files using marshal, zlib, and base64
Produces compact, obfuscated bytecode files
"""

import sys
import os
import marshal
import zlib
import base64
import argparse
from pathlib import Path


class PyCompiler:
    """Compile Python files with marshal, zlib, and base64 encoding."""
    
    MAGIC_HEADER = b"PYCMP"
    VERSION = 1
    
    def __init__(self, compression_level=9):
        """Initialize compiler with compression level (0-9)."""
        self.compression_level = compression_level
    
    def compile_file(self, input_path, output_path=None):
        """Compile a Python file to compressed bytecode."""
        input_file = Path(input_path)
        if not input_file.exists():
            raise FileNotFoundError(f"File not found: {input_path}")
        if input_file.suffix != '.py':
            raise ValueError(f"Expected .py file, got: {input_file.suffix}")
        
        source_code = input_file.read_text(encoding='utf-8')
        
        try:
            code_object = compile(source_code, str(input_file), 'exec')
        except SyntaxError as e:
            raise SyntaxError(f"Failed to compile {input_path}: {e}")
        
        marshalled = marshal.dumps(code_object)
        compressed = zlib.compress(marshalled, self.compression_level)
        encoded = base64.b64encode(compressed)
        
        if output_path is None:
            output_path = input_file.with_suffix('.pyc')
        else:
            output_path = Path(output_path)
        
        with open(output_path, 'wb') as f:
            f.write(self.MAGIC_HEADER)
            f.write(self.VERSION.to_bytes(1, 'big'))
            f.write(encoded)
        
        return output_path
    
    def decompile_file(self, input_path):
        """Decompile a compiled bytecode file to code object."""
        input_file = Path(input_path)
        if not input_file.exists():
            raise FileNotFoundError(f"File not found: {input_path}")
        
        with open(input_file, 'rb') as f:
            header = f.read(len(self.MAGIC_HEADER))
            if header != self.MAGIC_HEADER:
                raise ValueError("Invalid compiled file: wrong magic header")
            
            version = int.from_bytes(f.read(1), 'big')
            if version != self.VERSION:
                raise ValueError(f"Unsupported version: {version}")
            
            encoded = f.read()
        
        compressed = base64.b64decode(encoded)
        marshalled = zlib.decompress(compressed)
        code_object = marshal.loads(marshalled)
        
        return code_object


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description='Compile Python files with marshal, zlib, and base64 encoding'
    )
    parser.add_argument('mode', choices=['compile', 'decompile'], help='Operation mode')
    parser.add_argument('input', help='Input file path')
    parser.add_argument('-o', '--output', help='Output file path')
    parser.add_argument('-l', '--level', type=int, default=9, help='Compression level (0-9, default: 9)')
    
    args = parser.parse_args()
    compiler = PyCompiler(compression_level=args.level)
    
    try:
        if args.mode == 'compile':
            output = compiler.compile_file(args.input, args.output)
            print(f"✓ Compiled: {args.input} -> {output}")
        else:
            code = compiler.decompile_file(args.input)
            print(f"✓ Decompiled: {args.input}")
            print(f"  Code object: {code}")
    except Exception as e:
        print(f"✗ Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
