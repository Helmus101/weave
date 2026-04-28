import Contacts
import Foundation

let store = CNContactStore()

let group = DispatchGroup()
group.enter()

var accessGranted = false
store.requestAccess(for: .contacts) { granted, error in
    accessGranted = granted
    group.leave()
}
group.wait()

if !accessGranted {
    print("{\"error\": \"Permission denied\"}")
    exit(1)
}
let keysToFetch = [
    CNContactGivenNameKey,
    CNContactFamilyNameKey,
    CNContactEmailAddressesKey,
    CNContactPhoneNumbersKey,
    CNContactOrganizationNameKey
] as [CNKeyDescriptor]

let request = CNContactFetchRequest(keysToFetch: keysToFetch)

var contactsList: [[String: Any]] = []

do {
    try store.enumerateContacts(with: request) { (contact, stop) in
        let givenName = contact.givenName
        let familyName = contact.familyName
        let fullName = [givenName, familyName].filter { !$0.isEmpty }.joined(separator: " ")
        
        if fullName.isEmpty { return }
        
        let emails = contact.emailAddresses.map { String($0.value) }
        let phones = contact.phoneNumbers.map { $0.value.stringValue }
        let org = contact.organizationName
        
        contactsList.append([
            "name": fullName,
            "emails": emails,
            "phones": phones,
            "organization": org
        ])
    }
    
    let jsonData = try JSONSerialization.data(withJSONObject: contactsList, options: .prettyPrinted)
    if let jsonString = String(data: jsonData, encoding: .utf8) {
        print(jsonString)
    }
} catch {
    print("{\"error\": \"\(error.localizedDescription)\"}")
    exit(1)
}
