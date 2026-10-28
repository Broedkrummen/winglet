"""Validate uploaded tool modules without importing or executing them."""
import ast
import re


def tool_module(name, content):
    if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", name):
        raise ValueError("Use a name starting with a lowercase letter, then letters, digits, - or _.")
    try:
        size = len(content.encode("utf-8")) if isinstance(content, str) else 0
    except UnicodeError:
        raise ValueError("The Python module must be valid UTF-8 text.") from None
    if not isinstance(content, str) or not content.strip() or size > 100_000:
        raise ValueError("Provide a Python module of at most 100 KB.")
    try:
        tree = ast.parse(content)
    except SyntaxError as exc:
        raise ValueError(f"Python syntax error on line {exc.lineno}.") from None
    register = next((node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "register"), None)
    if register is None or len(register.args.args) != 1:
        raise ValueError("The module needs def register(ctx). Start with the tool template.")
    tools = []
    for node in ast.walk(register):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "register_tool"
                and isinstance(node.func.value, ast.Name) and node.func.value.id == register.args.args[0].arg):
            if not {"toolset", "schema", "handler"}.issubset({k.arg for k in node.keywords}):
                raise ValueError("Each tool needs a toolset, schema and handler. Start with the template.")
            value = next((k.value for k in node.keywords if k.arg == "name"), None)
            if not isinstance(value, ast.Constant) or not isinstance(value.value, str) or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]{0,63}", value.value):
                raise ValueError("Each ctx.register_tool call needs a literal tool name.")
            tools.append(value.value)
    if not tools or len(tools) != len(set(tools)):
        raise ValueError("Register at least one tool with a unique name using ctx.register_tool.")
    return {"name": name, "version": "1.0.0", "description": "Custom tool uploaded from Winglet",
            "provides_tools": tools}
