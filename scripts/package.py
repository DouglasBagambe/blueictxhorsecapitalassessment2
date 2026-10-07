from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
root = Path(__file__).resolve().parents[1]
output = root.parent / 'DouglasBagambe_Dev_TakeHome.zip'
excluded_dirs = {'node_modules', 'dist', '.git', 'coverage', '__pycache__'}
excluded_files = {'.env', 'INTERVIEW_NOTES.md', 'LOCAL_RUN.md'}
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root)
        if (any(part in excluded_dirs for part in relative.parts) or path.name in excluded_files
                or (path.name.startswith('.env') and path.name != '.env.example')):
            continue
        if path.is_file() and path.suffix not in {'.log', '.zip', '.pyc'}:
            archive.write(path, Path(root.name) / relative)
with ZipFile(output) as archive:
    assert archive.testzip() is None
    assert not any('/.env' == '/' + Path(name).name for name in archive.namelist())
print(output)
