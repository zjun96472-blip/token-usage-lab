use std::{
    io::{self, Read},
    path::PathBuf,
};
use token_usage_lab::{
    api::{dispatch, Request},
    database::{self, Database},
    services::session_usage::SourceRoots,
};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut home = dirs::home_dir().ok_or("Home directory unavailable")?;
    let mut data = database::default_directory()?;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--home" => home = PathBuf::from(args.next().ok_or("Missing home")?),
            "--data-dir" => data = PathBuf::from(args.next().ok_or("Missing data directory")?),
            _ => return Err("Unknown CLI option".into()),
        }
    }
    let mut input = String::new();
    io::stdin().take(64 * 1024).read_to_string(&mut input)?;
    let request: Request = serde_json::from_str(&input)?;
    let db = Database::open(&data)?;
    let result = dispatch(&db, &SourceRoots::from_home(&home), request)?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
