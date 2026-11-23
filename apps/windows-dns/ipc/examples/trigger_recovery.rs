//! Disposable Windows CI: request exact DNS recovery via the independent
//! privileged broker while the main DNS service is stopped. Never UAC.
fn main() {
    match mnebydns_ipc::send_recovery() {
        Ok(()) => println!("Independent DNS recovery IPC succeeded without UAC"),
        Err(error) => {
            eprintln!("Independent DNS recovery IPC failed: {error}");
            std::process::exit(1);
        }
    }
}
