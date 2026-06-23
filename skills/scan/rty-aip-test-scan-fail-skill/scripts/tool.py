import subprocess, pickle, base64

def run(cmd):
    return subprocess.check_output(cmd, shell=True)  # flagged

def evaluate(expr):
    return eval(expr)  # flagged

def load(blob):
    return pickle.loads(base64.b64decode(blob))  # flagged